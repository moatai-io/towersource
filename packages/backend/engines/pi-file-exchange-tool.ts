// Owns: agent-bound File Exchange delivery from the current Project workspace.
import fs from 'fs/promises';
import path from 'path';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { getProject } from '../services/pm/project-manager.js';
import { isPathAccessible } from '../services/pm/project-access.js';
import { confirmFileTransferPlan, executeFileTransfer, inspectFileTransfer } from '../services/file-exchange/file-exchange-service.js';
import { getSessionProjectAgentRuntimeProfile } from '../services/pm/project-agent-profile.js';

export interface FileExchangeToolContext {
  userId?: number;
  userRole?: string;
  sessionId: string;
  projectId?: string;
  askUser: (questionId: string, questions: any[]) => Promise<string>;
}

function text(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }], isError, details: undefined };
}

function normalizeRelativePath(input: string): string | null {
  const relativePath = input.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!relativePath || relativePath.split('/').some(part => !part || part === '..')) return null;
  return relativePath;
}

function actorFor(ctx: FileExchangeToolContext, profileVersion: number | null) {
  return {
    userId: ctx.userId!, role: ctx.userRole || 'member',
    principal: { kind: 'agent' as const, projectId: ctx.projectId!, sessionId: ctx.sessionId, profileVersion },
  };
}

async function listDirectoryFiles(root: string, relativeDirectory: string, actor: { userId: number; role: string }): Promise<string[]> {
  const absoluteRoot = path.resolve(root);
  const sourceRoot = path.resolve(root, relativeDirectory);
  if (sourceRoot !== absoluteRoot && !sourceRoot.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error('invalid current-Project directory path');
  if (!await isPathAccessible(sourceRoot, actor.userId, actor.role)) throw new Error('current-Project directory access denied');
  const sourceStat = await fs.lstat(sourceRoot).catch(() => null);
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('current-Project directory not found');
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('symbolic links are not supported in directory delivery');
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'));
      if (files.length > 1000) throw new Error('directory delivery is limited to 1000 files');
    }
  }
  await walk(sourceRoot);
  if (!files.length) throw new Error('directory has no files to deliver');
  return files;
}

/** Deliver one current-Project file without allowing the model to assert a foreign source Project or raw host path. */
export function createDeliverFileTool(ctx: FileExchangeToolContext): ToolDefinition | null {
  if (!ctx.userId || !ctx.projectId) return null;
  return {
    name: 'deliver_file',
    label: 'Deliver File',
    description: 'Copy one file from the current AI teammate Project workspace to this conversation, the authenticated user’s Personal Space, or another accessible AI teammate Project. The source is always resolved inside the current Project.',
    promptSnippet: 'Use deliver_file only when the user asked to deliver, hand off, attach, or save an existing current-Project file. Personal Space and another Project require explicit user approval before calling this tool.',
    promptGuidelines: [
      'sourceRelativePath must be a current-Project relative path, never an absolute host path.',
      'destination=session attaches a snapshot to the current conversation.',
      'destination=personal creates an owner-only copy and requires explicit user approval before the call.',
      'destination=project copies into another accessible AI teammate workspace and requires explicit user approval before the call.',
      'This tool copies; it never deletes or moves the source.',
    ],
    parameters: Type.Object({
      sourceRelativePath: Type.String({ minLength: 1, maxLength: 2000 }),
      destination: Type.Union([Type.Literal('session'), Type.Literal('personal'), Type.Literal('project')]),
      destinationProjectId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      destinationDirectory: Type.Optional(Type.String({ maxLength: 1000 })),
    }),
    async execute(_id: string, params: {
      sourceRelativePath: string;
      destination: 'session' | 'personal' | 'project';
      destinationProjectId?: string;
      destinationDirectory?: string;
    }) {
      try {
        const relativePath = params.sourceRelativePath.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!relativePath || relativePath.split('/').some(part => part === '..')) return text('deliver_file failed: invalid current-Project relative path', true);
        if (params.destination === 'project' && !params.destinationProjectId) return text('deliver_file failed: destinationProjectId is required', true);
        if (params.destination === 'project' && params.destinationProjectId === ctx.projectId) return text('deliver_file failed: use the file workspace for changes inside the same Project', true);
        const profile = await getSessionProjectAgentRuntimeProfile(ctx.sessionId, ctx.projectId!);
        const actor = actorFor(ctx, profile?.profileVersion ?? null);
        const destination = params.destination === 'session'
          ? { scope: 'session' as const, sessionId: ctx.sessionId }
          : params.destination === 'personal'
            ? { scope: 'personal' as const, relativeDirectory: params.destinationDirectory || 'files' }
            : { scope: 'project' as const, projectId: params.destinationProjectId!, relativeDirectory: params.destinationDirectory || 'uploads' };
        const plan = await inspectFileTransfer(actor, {
          source: { scope: 'project', projectId: ctx.projectId!, relativePath },
          destination,
        });
        if (plan.confirmationRequired) {
          const answer = await ctx.askUser(`file-exchange-${plan.id}`, [{
            question: plan.confirmationMessage || `파일 ${plan.sourceName}을 전달할까요?`,
            header: '파일 전달 승인',
            options: [
              { label: '전달 승인', description: '이 계획의 독립 사본 전달을 승인합니다.' },
              { label: '취소', description: '파일을 전달하지 않습니다.' },
            ],
          }]);
          if (!/^전달 승인(?:\s|$)/.test(String(answer || '').trim())) return text({ ok: false, action: 'deliver_file', cancelled: true });
          await confirmFileTransferPlan(actor, plan.id);
        }
        const receipt = await executeFileTransfer(actor, plan.id);
        return text({ ok: receipt.status === 'completed', action: 'deliver_file', receipt });
      } catch (error) {
        return text(`deliver_file failed: ${(error as Error).message}`, true);
      }
    },
  } as ToolDefinition;
}

/** Deliver one current-Project directory tree to another accessible AI teammate Project. */
export function createDeliverDirectoryTool(ctx: FileExchangeToolContext): ToolDefinition | null {
  if (!ctx.userId || !ctx.projectId) return null;
  return {
    name: 'deliver_directory',
    label: 'Deliver Directory',
    description: 'Copy a directory tree from the current AI teammate Project to another accessible AI teammate Project while preserving relative paths. Existing files are never overwritten.',
    promptSnippet: 'Use deliver_directory when the user explicitly asks to copy or hand off a current-Project folder to another AI teammate Project. Always require explicit user approval for the exact destination and manifest.',
    promptGuidelines: [
      'sourceRelativePath must be a current-Project relative directory, never an absolute host path.',
      'destinationProjectId is required and must identify another accessible Project.',
      'The source directory basename and its relative file tree are preserved under destinationDirectory (default: uploads).',
      'The tool copies files only; it never deletes or moves the source and never overwrites existing files.',
      'Symbolic links and directories containing more than 1000 files are rejected.',
    ],
    parameters: Type.Object({
      sourceRelativePath: Type.String({ minLength: 1, maxLength: 2000 }),
      destinationProjectId: Type.String({ minLength: 1, maxLength: 100 }),
      destinationDirectory: Type.Optional(Type.String({ maxLength: 1000 })),
    }),
    async execute(_id: string, params: { sourceRelativePath: string; destinationProjectId: string; destinationDirectory?: string }) {
      try {
        const relativeDirectory = normalizeRelativePath(params.sourceRelativePath);
        const destinationDirectory = params.destinationDirectory ? normalizeRelativePath(params.destinationDirectory) : 'uploads';
        if (!relativeDirectory) return text('deliver_directory failed: invalid current-Project relative path', true);
        if (!destinationDirectory) return text('deliver_directory failed: invalid destination directory', true);
        if (params.destinationProjectId === ctx.projectId) return text('deliver_directory failed: use the file workspace for changes inside the same Project', true);
        const sourceProject = await getProject(ctx.projectId!);
        if (!sourceProject?.rootPath) return text('deliver_directory failed: current Project workspace not found', true);
        const profile = await getSessionProjectAgentRuntimeProfile(ctx.sessionId, ctx.projectId!);
        const actor = actorFor(ctx, profile?.profileVersion ?? null);
        const files = await listDirectoryFiles(sourceProject.rootPath, relativeDirectory, actor);
        const sourceParent = path.posix.dirname(relativeDirectory);
        const plans: Array<{ id: string; sourceSizeBytes: number }> = [];
        for (const sourceRelativePath of files) {
          const relativeFromParent = path.posix.relative(sourceParent === '.' ? '' : sourceParent, sourceRelativePath);
          const targetDirectory = path.posix.join(destinationDirectory, path.posix.dirname(relativeFromParent));
          const plan = await inspectFileTransfer(actor, {
            source: { scope: 'project', projectId: ctx.projectId!, relativePath: sourceRelativePath },
            destination: { scope: 'project', projectId: params.destinationProjectId, relativeDirectory: targetDirectory },
          });
          plans.push({ id: plan.id, sourceSizeBytes: plan.sourceSizeBytes });
        }
        const totalBytes = plans.reduce((sum, plan) => sum + plan.sourceSizeBytes, 0);
        const answer = await ctx.askUser(`directory-exchange-${plans[0].id}`, [{
          question: `'${relativeDirectory}' 폴더의 ${plans.length}개 파일(${totalBytes} bytes)을 '${params.destinationProjectId}' 프로젝트의 '${destinationDirectory}' 아래에 복사할까요? 기존 파일은 덮어쓰지 않고 이름을 바꿔 보존합니다.`,
          header: '폴더 전달 승인',
          options: [
            { label: '폴더 전달 승인', description: '표시된 폴더 트리의 독립 사본 전달을 승인합니다.' },
            { label: '취소', description: '폴더를 전달하지 않습니다.' },
          ],
        }]);
        if (!/^폴더 전달 승인(?:\s|$)/.test(String(answer || '').trim())) return text({ ok: false, action: 'deliver_directory', cancelled: true, fileCount: plans.length, totalBytes });
        for (const plan of plans) await confirmFileTransferPlan(actor, plan.id);
        const receipts = [];
        for (const plan of plans) receipts.push(await executeFileTransfer(actor, plan.id));
        const completedCount = receipts.filter(receipt => receipt.status === 'completed').length;
        return text({ ok: completedCount === receipts.length, action: 'deliver_directory', sourceRelativePath: relativeDirectory, destinationProjectId: params.destinationProjectId, destinationDirectory, fileCount: receipts.length, completedCount, totalBytes, receipts });
      } catch (error) {
        return text(`deliver_directory failed: ${(error as Error).message}`, true);
      }
    },
  } as ToolDefinition;
}
