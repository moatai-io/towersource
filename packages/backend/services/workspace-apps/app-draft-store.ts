/**
 * Owns: project-local Workspace Apps draft intent persistence. Public API: save/list/read Workspace App drafts.
 * See README.md.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  WorkspaceAppBuilderDraftPreviewSchema,
  type WorkspaceAppBuilderDraftPreview,
  type WorkspaceAppDefinition,
} from './app-definition-schema.js';

const DRAFTS_DIR = '.workspace-apps/drafts';
const MAX_DRAFT_BYTES = 128 * 1024;

export const WorkspaceAppDraftRecordSchema = z.object({
  id: z.string().uuid(),
  appId: z.string().min(1).max(80),
  projectId: z.string().min(1).max(120),
  baseSourcePath: z.string().max(500).optional(),
  createdAt: z.string().datetime(),
  actorUserId: z.number().int().positive(),
  status: z.literal('draft'),
  draftPreview: WorkspaceAppBuilderDraftPreviewSchema,
});

export type WorkspaceAppDraftRecord = z.infer<typeof WorkspaceAppDraftRecordSchema>;

function assertAppId(appId: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(appId)) throw new Error('invalid workspace app id');
}

function projectRootReal(projectRoot: string): string {
  return fs.realpathSync(projectRoot);
}

function assertInsideProject(rootReal: string, targetPath: string): string {
  const resolved = path.resolve(targetPath);
  if (!(resolved === rootReal || resolved.startsWith(rootReal + path.sep))) {
    throw new Error('workspace app draft path escapes project root');
  }
  return resolved;
}

function ensureInsideProject(projectRoot: string, targetPath: string): string {
  const rootReal = projectRootReal(projectRoot);
  const resolved = path.resolve(rootReal, targetPath);
  const parent = path.dirname(resolved);
  fs.mkdirSync(parent, { recursive: true });
  const parentReal = fs.realpathSync(parent);
  if (!(parentReal === rootReal || parentReal.startsWith(rootReal + path.sep))) {
    throw new Error('workspace app draft path escapes project root');
  }
  return resolved;
}

function draftDirectory(projectRoot: string, appId: string): string {
  assertAppId(appId);
  const rootReal = projectRootReal(projectRoot);
  return assertInsideProject(rootReal, path.resolve(rootReal, DRAFTS_DIR, appId));
}

function parseDraftFile(filePath: string): WorkspaceAppDraftRecord | null {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_DRAFT_BYTES) return null;
  return WorkspaceAppDraftRecordSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

export function buildWorkspaceAppDraftRecord(input: {
  projectId: string;
  definition: WorkspaceAppDefinition;
  actorUserId: number;
  draftPreview: WorkspaceAppBuilderDraftPreview;
  now?: Date;
  draftId?: string;
}): WorkspaceAppDraftRecord {
  return WorkspaceAppDraftRecordSchema.parse({
    id: input.draftId ?? randomUUID(),
    appId: input.definition.id,
    projectId: input.projectId,
    baseSourcePath: input.definition.sourcePath,
    createdAt: (input.now ?? new Date()).toISOString(),
    actorUserId: input.actorUserId,
    status: 'draft',
    draftPreview: WorkspaceAppBuilderDraftPreviewSchema.parse(input.draftPreview),
  });
}

export function saveWorkspaceAppDraft(input: {
  projectRoot: string;
  projectId: string;
  definition: WorkspaceAppDefinition;
  actorUserId: number;
  draftPreview: WorkspaceAppBuilderDraftPreview;
  now?: Date;
}): WorkspaceAppDraftRecord {
  const record = buildWorkspaceAppDraftRecord(input);
  assertAppId(record.appId);
  const relativePath = path.join(DRAFTS_DIR, record.appId, `${record.id}.json`);
  const targetPath = ensureInsideProject(input.projectRoot, relativePath);
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(payload, 'utf8') > MAX_DRAFT_BYTES) throw new Error('workspace app draft is too large');
  fs.writeFileSync(targetPath, payload, { encoding: 'utf8', flag: 'wx', mode: 0o640 });
  return record;
}

export function listWorkspaceAppDrafts(input: {
  projectRoot: string;
  appId: string;
  limit?: number;
}): WorkspaceAppDraftRecord[] {
  const dir = draftDirectory(input.projectRoot, input.appId);
  if (!fs.existsSync(dir)) return [];
  const rootReal = projectRootReal(input.projectRoot);
  const dirReal = fs.realpathSync(dir);
  assertInsideProject(rootReal, dirReal);
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  return fs.readdirSync(dirReal)
    .filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
    .map((name) => path.join(dirReal, name))
    .map((filePath) => {
      try { return parseDraftFile(filePath); } catch { return null; }
    })
    .filter((draft): draft is WorkspaceAppDraftRecord => draft !== null && draft.appId === input.appId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export function readWorkspaceAppDraft(input: {
  projectRoot: string;
  appId: string;
  draftId: string;
}): WorkspaceAppDraftRecord | null {
  assertAppId(input.appId);
  if (!/^[0-9a-f-]{36}$/i.test(input.draftId)) throw new Error('invalid workspace app draft id');
  const dir = draftDirectory(input.projectRoot, input.appId);
  const filePath = path.join(dir, `${input.draftId}.json`);
  if (!fs.existsSync(filePath)) return null;
  const rootReal = projectRootReal(input.projectRoot);
  const fileReal = fs.realpathSync(filePath);
  assertInsideProject(rootReal, fileReal);
  const draft = parseDraftFile(fileReal);
  if (!draft || draft.appId !== input.appId || draft.id !== input.draftId) return null;
  return draft;
}
