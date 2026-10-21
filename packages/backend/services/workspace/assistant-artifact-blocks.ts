import { parseArtifactFences } from '../../../shared/artifact-fences.js';
/**
 * Owns: assistant response fenced artifact blocks → durable Markdown files.
 * Public API: parse/normalize assistant artifact blocks and materialize them under the Session workspace.
 *
 * This lets a model produce one body once, have Tower render that same body in chat,
 * and save it as a Markdown artifact without asking the model to repeat the content.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { queryOne } from '../../db/pg-repo.js';
import {
  compareAndSwapProjectWorkspaceText,
  createProjectWorkspaceDirectory,
  projectWorkspaceEntryExists,
  readProjectWorkspaceFileBytes,
  resolveProjectWorkspaceFile,
  writeProjectWorkspaceText,
} from '../project-environment/project-workspace-files.js';
import { isPathWritableByRole } from '../pm/project-access.js';
import { assertSessionAllowsSharedArtifactWrite } from '../session/session-artifact-privacy.js';


const PORTABLE_WORKSPACE_PREFIX = '~/workspace/';
const ALLOWED_TOP_LEVEL_DIRS = new Set(['work', 'final', 'docs', 'records', 'sources']);

export interface AssistantArtifactBlock {
  type: 'artifact_markdown';
  path: string;
  title?: string;
  text: string;
  sha256?: string;
  status?: 'saved' | 'pending' | 'skipped' | 'error';
  error?: string;
}

type TextBlock = { type: 'text'; text: string };
type ContentBlock = Record<string, any>;

interface SessionWorkspaceRow {
  cwd: string | null;
  project_id: string | null;
  project_root: string | null;
  user_id: number | null;
  user_role: string | null;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

function isSafeMarkdownRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.includes('\0')) return false;
  if (path.isAbsolute(relativePath)) return false;
  const normalized = relativePath.split('\\').join('/');
  if (normalized.startsWith('../') || normalized.includes('/../') || normalized === '..') return false;
  if (normalized.startsWith('./')) return false;
  if (normalized.split('/').some((part) => !part || part === '.' || part.startsWith('.'))) return false;
  if (!/\.md(?:own)?$/i.test(normalized)) return false;
  const [top] = normalized.split('/');
  return ALLOWED_TOP_LEVEL_DIRS.has(top);
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.trim().split('\\').join('/').replace(/^\/+/, '');
}

function isOnlyFenceWrapperRemainder(text: string): boolean {
  const trimmed = text.trim();
  return /^```(?:md|markdown)?$/i.test(trimmed) || trimmed === '```';
}

export function normalizeAssistantArtifactBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string' || !block.text.includes('```tower-artifact')) {
      out.push(block);
      continue;
    }

    let lastIndex = 0;
    for (const match of parseArtifactFences(block.text)) {
      const before = block.text.slice(lastIndex, match.index);
      if (before && !isOnlyFenceWrapperRemainder(before)) out.push({ type: 'text', text: before } satisfies TextBlock);

      const attrs = parseAttrs(match.attrs);
      const relativePath = normalizeRelativePath(attrs.path || '');
      const text = match.body;
      const title = attrs.title?.trim() || undefined;
      const artifact: AssistantArtifactBlock = {
        type: 'artifact_markdown',
        path: relativePath,
        title,
        text,
        sha256: crypto.createHash('sha256').update(text).digest('hex'),
        status: isSafeMarkdownRelativePath(relativePath) ? 'pending' : 'skipped',
        error: isSafeMarkdownRelativePath(relativePath) ? undefined : 'unsafe_or_unsupported_artifact_path',
      };
      out.push(artifact);
      lastIndex = match.end;
    }

    const after = block.text.slice(lastIndex);
    if (after && !isOnlyFenceWrapperRemainder(after)) out.push({ type: 'text', text: after } satisfies TextBlock);
  }
  return out;
}

function isAssistantArtifactBlock(block: ContentBlock): block is AssistantArtifactBlock {
  return block?.type === 'artifact_markdown'
    && typeof block.path === 'string'
    && typeof block.text === 'string';
}

export function hasAssistantArtifactCandidate(blocks: ContentBlock[]): boolean {
  return blocks.some((block) => isAssistantArtifactBlock(block)
    || (block?.type === 'text' && typeof block.text === 'string' && block.text.includes('```tower-artifact')));
}

async function resolveSessionWorkspace(sessionId: string): Promise<(SessionWorkspaceRow & { root: string }) | null> {
  const row = await queryOne<SessionWorkspaceRow>(
    `SELECT s.cwd, s.project_id, p.root_path AS project_root, s.user_id, u.role AS user_role
       FROM sessions s
       LEFT JOIN projects p ON p.id = s.project_id
       LEFT JOIN users u ON u.id = s.user_id
      WHERE s.id = $1`,
    [sessionId],
  );
  const root = row?.project_root || row?.cwd || null;
  return row && root ? { ...row, root: path.resolve(root) } : null;
}

function portablePath(workspaceRoot: string, filePath: string): string {
  const workspace = process.env.WORKSPACE_ROOT ? path.resolve(process.env.WORKSPACE_ROOT) : null;
  if (workspace) {
    const rel = path.relative(workspace, filePath).split(path.sep).join('/');
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return `${PORTABLE_WORKSPACE_PREFIX}${rel}`;
  }
  return filePath;
}

export async function materializeAssistantArtifactBlocks(sessionId: string, blocks: ContentBlock[]): Promise<ContentBlock[]> {
  const artifactIndexes = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => isAssistantArtifactBlock(block));
  if (artifactIndexes.length === 0) return blocks;

  try {
    await assertSessionAllowsSharedArtifactWrite(sessionId);
  } catch (error) {
    // Preserve the answer as conversation content, but never publish its private body.
    return blocks.map(block => isAssistantArtifactBlock(block) ? {
      ...block, status: 'error', error: error instanceof Error ? error.message : String(error),
    } : block);
  }

  const workspace = await resolveSessionWorkspace(sessionId);
  if (!workspace) {
    return blocks.map((block) => isAssistantArtifactBlock(block)
      ? { ...block, status: 'error', error: 'session_workspace_not_found' }
      : block);
  }

  const next = [...blocks];
  for (const { block, index } of artifactIndexes) {
    if (!isAssistantArtifactBlock(block)) continue;
    const relativePath = normalizeRelativePath(block.path);
    if (!isSafeMarkdownRelativePath(relativePath)) {
      next[index] = { ...block, path: relativePath, status: 'skipped', error: 'unsafe_or_unsupported_artifact_path' };
      continue;
    }

    const workspaceRoot = workspace.root;
    const target = path.resolve(workspaceRoot, ...relativePath.split('/'));
    if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${path.sep}`)) {
      next[index] = { ...block, path: relativePath, status: 'skipped', error: 'artifact_path_outside_workspace' };
      continue;
    }

    try {
      const body = block.text.endsWith('\n') ? block.text : `${block.text}\n`;
      if (workspace.project_id && workspace.user_id) {
        if (!await isPathWritableByRole(target, workspace.user_id, workspace.user_role || 'member')) throw new Error('PROJECT_FILE_WRITE_ACCESS_REVOKED');
        const reference = await resolveProjectWorkspaceFile({ projectId: workspace.project_id, projectRoot: workspaceRoot, relativePath });
        const parent = path.posix.dirname(relativePath);
        if (parent !== '.') {
          const directory = await resolveProjectWorkspaceFile({ projectId: workspace.project_id, projectRoot: workspaceRoot, relativePath: parent });
          await createProjectWorkspaceDirectory({ reference: directory, actorUserId: workspace.user_id, exclusive: false });
        }
        if ((await projectWorkspaceEntryExists({ reference, actorUserId: workspace.user_id })).exists) {
          const current = (await readProjectWorkspaceFileBytes({ reference, actorUserId: workspace.user_id, maxBytes: 50 * 1024 * 1024 })).bytes.toString('utf8');
          if (current !== body) await compareAndSwapProjectWorkspaceText({ reference, actorUserId: workspace.user_id, expectedContent: current, content: body });
        } else {
          await writeProjectWorkspaceText({ reference, actorUserId: workspace.user_id, content: body, exclusive: true });
        }
      } else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, body, 'utf8');
      }
      next[index] = {
        ...block,
        path: relativePath,
        portablePath: portablePath(workspaceRoot, target),
        sha256: crypto.createHash('sha256').update(block.text).digest('hex'),
        status: 'saved',
        error: undefined,
      };
    } catch (err: any) {
      next[index] = { ...block, path: relativePath, status: 'error', error: err?.message || 'artifact_write_failed' };
    }
  }
  return next;
}
