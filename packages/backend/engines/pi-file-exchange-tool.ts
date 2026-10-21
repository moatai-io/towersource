// Owns: agent-bound File Exchange delivery from the current Project workspace.
import fs from 'fs/promises';
import path from 'path';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { getProject, getProjects, type Project } from '../services/pm/project-manager.js';
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

type ApprovalAnswer =
  | { status: 'approved' }
  | { status: 'user_cancelled' }
  | { status: 'approval_unavailable'; detail?: string }
  | { status: 'approval_timeout'; detail?: string }
  | { status: 'invalid_answer'; detail?: string };

function classifyApprovalAnswer(answer: unknown, approvalLabel: string, cancelLabel = '취소'): ApprovalAnswer {
  const raw = String(answer || '').trim();
  const selectedAnswers = raw.split('\n').map((line) => {
    const separator = line.lastIndexOf(':');
    return (separator >= 0 ? line.slice(separator + 1) : line).trim();
  }).filter(Boolean);
  if (selectedAnswers.includes(approvalLabel)) return { status: 'approved' };
  if (selectedAnswers.includes(cancelLabel) || /\[User skipped the interactive question\]/i.test(raw)) return { status: 'user_cancelled' };
  if (/no user answer available|interactive (?:prompt|approval).*unavailable|cannot ask (?:an? )?(?:interactive )?(?:question|user)/i.test(raw)) {
    return { status: 'approval_unavailable', detail: raw.slice(0, 300) };
  }
  if (/did not respond.*within|timed? out|시간 초과/i.test(raw)) return { status: 'approval_timeout', detail: raw.slice(0, 300) };
  return { status: 'invalid_answer', detail: raw.slice(0, 300) };
}

function approvalFailure(action: string, answer: Exclude<ApprovalAnswer, { status: 'approved' }>) {
  const errorCode = answer.status === 'approval_unavailable'
    ? 'APPROVAL_UI_UNAVAILABLE'
    : answer.status === 'approval_timeout'
      ? 'APPROVAL_TIMEOUT'
      : answer.status === 'invalid_answer'
        ? 'APPROVAL_INVALID_ANSWER'
        : undefined;
  const detail = 'detail' in answer ? answer.detail : undefined;
  return text({
    ok: false,
    action,
    status: answer.status,
    cancelled: answer.status === 'user_cancelled',
    ...(errorCode ? { errorCode } : {}),
    ...(detail ? { detail } : {}),
  }, answer.status !== 'user_cancelled');
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

type ResolvedProjectDestination = { projectId: string; projectLabel: string; inferredDirectory?: string };

function projectLabels(project: Project): string[] {
  const displayName = project.agent?.displayName;
  return [project.name, displayName].filter((value): value is string => Boolean(value?.trim()));
}

function normalizeLookup(value: string): string {
  return value.trim().toLocaleLowerCase();
}

async function resolveProjectDestination(
  ctx: FileExchangeToolContext,
  reference: string,
): Promise<ResolvedProjectDestination> {
  const projects = await getProjects(ctx.userId!, ctx.userRole || 'member');
  const exactId = projects.find(project => project.id === reference);
  if (exactId) return { projectId: exactId.id, projectLabel: projectLabels(exactId)[0] || exactId.id };

  const lookup = normalizeLookup(reference);
  const nameMatches = projects.filter(project => projectLabels(project).some(label => normalizeLookup(label) === lookup));
  if (nameMatches.length === 1) {
    const project = nameMatches[0];
    return { projectId: project.id, projectLabel: projectLabels(project)[0] || project.id };
  }
  if (nameMatches.length > 1) {
    const candidates = nameMatches.map(project => ({ projectId: project.id, names: projectLabels(project) }));
    throw new Error(`destination Project is ambiguous: ${JSON.stringify(candidates)}`);
  }

  if (path.isAbsolute(reference)) {
    const resolvedReference = path.resolve(reference);
    const pathMatches = projects.filter(project => {
      if (!project.rootPath) return false;
      const root = path.resolve(project.rootPath);
      return resolvedReference === root || resolvedReference.startsWith(`${root}${path.sep}`);
    });
    if (pathMatches.length === 1) {
      const project = pathMatches[0];
      const root = path.resolve(project.rootPath!);
      const relative = path.relative(root, resolvedReference).split(path.sep).join('/');
      return {
        projectId: project.id,
        projectLabel: projectLabels(project)[0] || project.id,
        inferredDirectory: relative || undefined,
      };
    }
  }

  throw new Error('destination Project was not found among Projects accessible to the current user');
}

async function resolveDestinationInputs(
  ctx: FileExchangeToolContext,
  params: { destinationProjectId?: string; destinationProject?: string; destinationDirectory?: string },
): Promise<ResolvedProjectDestination & { destinationDirectory: string }> {
  const reference = params.destinationProject || params.destinationProjectId;
  if (!reference) throw new Error('destinationProject is required (Project UUID, agent/Project name, or accessible absolute Project path)');
  const resolved = await resolveProjectDestination(ctx, reference);
  const destinationDirectory = params.destinationDirectory
    ? normalizeRelativePath(params.destinationDirectory)
    : resolved.inferredDirectory || 'uploads';
  if (!destinationDirectory) throw new Error('invalid destination directory');
  return { ...resolved, destinationDirectory };
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

/** Import one owner-scoped Personal Space file into the current Project after exact-plan approval. */
export function createImportPersonalFileToProjectTool(ctx: FileExchangeToolContext): ToolDefinition | null {
  if (!ctx.userId || !ctx.projectId) return null;
  return {
    name: 'import_personal_file_to_project',
    label: 'Personal Space 파일 가져오기',
    description: 'Copy one authenticated user-owned personal:// file into the current AI teammate Project. The Personal Space source remains unchanged, the destination never overwrites an existing file, and the exact transfer plan requires explicit user approval.',
    promptSnippet: 'Use import_personal_file_to_project when the user explicitly asks to bring, copy, import, or apply a specific personal:// file in the current Project. After import, use ordinary Project file tools on the returned relativePath.',
    promptGuidelines: [
      'sourceUri must be the exact personal:// URI supplied or selected by the user; never invent or enumerate private note paths.',
      'The destination is always the current Project. destinationDirectory defaults to uploads and must be Project-relative.',
      'The tool copies the source and never edits, moves, archives, or deletes the Personal Space original.',
      'The server verifies Personal Space ownership and current Project write authority before and immediately before copying.',
      'The tool always asks the user to approve the exact source, destination, and collision-safe copy before execution.',
      'After success, read and edit only the returned current-Project relativePath unless the user separately asks to change the Personal Space original.',
    ],
    parameters: Type.Object({
      sourceUri: Type.String({ minLength: 12, maxLength: 2000, pattern: '^personal://', description: 'Exact Personal Space file URI, such as personal://notes/draft.md.' }),
      destinationDirectory: Type.Optional(Type.String({ maxLength: 1000, description: 'Current-Project relative destination directory. Defaults to uploads.' })),
    }),
    async execute(_id: string, params: { sourceUri: string; destinationDirectory?: string }) {
      try {
        if (!params.sourceUri.startsWith('personal://')) return text('import_personal_file_to_project failed: sourceUri must start with personal://', true);
        const destinationDirectory = params.destinationDirectory ? normalizeRelativePath(params.destinationDirectory) : 'uploads';
        if (!destinationDirectory) return text('import_personal_file_to_project failed: invalid destinationDirectory', true);
        const profile = await getSessionProjectAgentRuntimeProfile(ctx.sessionId, ctx.projectId!);
        const actor = actorFor(ctx, profile?.profileVersion ?? null);
        const plan = await inspectFileTransfer(actor, {
          source: { scope: 'personal', uri: params.sourceUri },
          destination: { scope: 'project', projectId: ctx.projectId!, relativeDirectory: destinationDirectory },
        });
        const answer = await ctx.askUser(`personal-import-${plan.id}`, [{
          question: `'${plan.sourceName}'의 독립 사본을 현재 프로젝트의 '${destinationDirectory}'에 가져올까요? Personal Space 원본은 변경하지 않으며 기존 파일은 덮어쓰지 않습니다.`,
          header: 'Personal Space 가져오기 승인',
          options: [
            { label: '가져오기 승인', description: '표시된 파일과 대상 경로로 독립 사본을 만듭니다.' },
            { label: '취소', description: '프로젝트에 파일을 만들지 않습니다.' },
          ],
        }]);
        const approval = classifyApprovalAnswer(answer, '가져오기 승인');
        if (approval.status !== 'approved') return approvalFailure('import_personal_file_to_project', approval);
        await confirmFileTransferPlan(actor, plan.id);
        const receipt = await executeFileTransfer(actor, plan.id);
        return text({
          ok: receipt.status === 'completed',
          action: 'import_personal_file_to_project',
          sourceUri: params.sourceUri,
          destinationProjectId: ctx.projectId,
          destinationDirectory,
          relativePath: receipt.result?.scope === 'project' && typeof receipt.result.relativePath === 'string' ? receipt.result.relativePath : undefined,
          receipt,
        });
      } catch (error) {
        return text(`import_personal_file_to_project failed: ${(error as Error).message}`, true);
      }
    },
  } as ToolDefinition;
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
      'For a Project destination, pass destinationProject as a Project UUID, exact agent/Project name, or accessible absolute path inside that Project. destinationProjectId remains supported for compatibility.',
      'An absolute destinationProject path infers the destination directory unless destinationDirectory is provided explicitly.',
      'This tool copies; it never deletes or moves the source.',
    ],
    parameters: Type.Object({
      sourceRelativePath: Type.String({ minLength: 1, maxLength: 2000 }),
      destination: Type.Union([Type.Literal('session'), Type.Literal('personal'), Type.Literal('project')]),
      destinationProject: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: 'Project UUID, exact agent/Project name, or accessible absolute path inside the destination Project.' })),
      destinationProjectId: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: 'Deprecated compatibility alias for a destination Project UUID.' })),
      destinationDirectory: Type.Optional(Type.String({ maxLength: 1000 })),
    }),
    async execute(_id: string, params: {
      sourceRelativePath: string;
      destination: 'session' | 'personal' | 'project';
      destinationProject?: string;
      destinationProjectId?: string;
      destinationDirectory?: string;
    }) {
      try {
        const relativePath = params.sourceRelativePath.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!relativePath || relativePath.split('/').some(part => part === '..')) return text('deliver_file failed: invalid current-Project relative path', true);
        const resolvedProject = params.destination === 'project' ? await resolveDestinationInputs(ctx, params) : null;
        if (resolvedProject?.projectId === ctx.projectId) return text('deliver_file failed: use the file workspace for changes inside the same Project', true);
        const profile = await getSessionProjectAgentRuntimeProfile(ctx.sessionId, ctx.projectId!);
        const actor = actorFor(ctx, profile?.profileVersion ?? null);
        const destination = params.destination === 'session'
          ? { scope: 'session' as const, sessionId: ctx.sessionId }
          : params.destination === 'personal'
            ? { scope: 'personal' as const, relativeDirectory: params.destinationDirectory || 'files' }
            : { scope: 'project' as const, projectId: resolvedProject!.projectId, relativeDirectory: resolvedProject!.destinationDirectory };
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
          const approval = classifyApprovalAnswer(answer, '전달 승인');
          if (approval.status !== 'approved') return approvalFailure('deliver_file', approval);
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
      'destinationProject accepts a Project UUID, exact agent/Project name, or accessible absolute path inside another Project. destinationProjectId remains supported for compatibility.',
      'The source directory basename and its relative file tree are preserved under destinationDirectory (default: uploads, or the directory inferred from an absolute destinationProject path).',
      'The tool copies files only; it never deletes or moves the source and never overwrites existing files.',
      'Symbolic links and directories containing more than 1000 files are rejected.',
    ],
    parameters: Type.Object({
      sourceRelativePath: Type.String({ minLength: 1, maxLength: 2000 }),
      destinationProject: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: 'Project UUID, exact agent/Project name, or accessible absolute path inside the destination Project.' })),
      destinationProjectId: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: 'Deprecated compatibility alias for a destination Project UUID.' })),
      destinationDirectory: Type.Optional(Type.String({ maxLength: 1000 })),
    }),
    async execute(_id: string, params: { sourceRelativePath: string; destinationProject?: string; destinationProjectId?: string; destinationDirectory?: string }) {
      try {
        const relativeDirectory = normalizeRelativePath(params.sourceRelativePath);
        if (!relativeDirectory) return text('deliver_directory failed: invalid current-Project relative path', true);
        const resolvedProject = await resolveDestinationInputs(ctx, params);
        const destinationDirectory = resolvedProject.destinationDirectory;
        if (resolvedProject.projectId === ctx.projectId) return text('deliver_directory failed: use the file workspace for changes inside the same Project', true);
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
            destination: { scope: 'project', projectId: resolvedProject.projectId, relativeDirectory: targetDirectory },
          });
          plans.push({ id: plan.id, sourceSizeBytes: plan.sourceSizeBytes });
        }
        const totalBytes = plans.reduce((sum, plan) => sum + plan.sourceSizeBytes, 0);
        const answer = await ctx.askUser(`directory-exchange-${plans[0].id}`, [{
          question: `'${relativeDirectory}' 폴더의 ${plans.length}개 파일(${totalBytes} bytes)을 '${resolvedProject.projectLabel}' 프로젝트의 '${destinationDirectory}' 아래에 복사할까요? 기존 파일은 덮어쓰지 않고 이름을 바꿔 보존합니다.`,
          header: '폴더 전달 승인',
          options: [
            { label: '폴더 전달 승인', description: '표시된 폴더 트리의 독립 사본 전달을 승인합니다.' },
            { label: '취소', description: '폴더를 전달하지 않습니다.' },
          ],
        }]);
        const approval = classifyApprovalAnswer(answer, '폴더 전달 승인');
        if (approval.status !== 'approved') {
          const failure = approvalFailure('deliver_directory', approval);
          failure.content[0].text = JSON.stringify({ ...JSON.parse(failure.content[0].text), fileCount: plans.length, totalBytes });
          return failure;
        }
        for (const plan of plans) await confirmFileTransferPlan(actor, plan.id);
        const receipts = [];
        for (const plan of plans) receipts.push(await executeFileTransfer(actor, plan.id));
        const completedCount = receipts.filter(receipt => receipt.status === 'completed').length;
        return text({ ok: completedCount === receipts.length, action: 'deliver_directory', sourceRelativePath: relativeDirectory, destinationProjectId: resolvedProject.projectId, destinationProjectName: resolvedProject.projectLabel, destinationDirectory, fileCount: receipts.length, completedCount, totalBytes, receipts });
      } catch (error) {
        return text(`deliver_directory failed: ${(error as Error).message}`, true);
      }
    },
  } as ToolDefinition;
}
