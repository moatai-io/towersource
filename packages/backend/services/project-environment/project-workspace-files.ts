import { resolveCanonicalWriteTarget } from './canonical-write-target.js';
import { isReadOnlyRole, isTowerRole } from '../authority/authorization-policy.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getUserAuthState } from '../auth/auth.js';
import { isProjectMember } from '../pm/project-membership-manager.js';
export type { ExpectedProjectWorkspaceStorage } from './adapters/project-workspace-storage-adapter.js';
import { getProject } from '../pm/project-manager.js';
import { assertExpectedStorage, type ExpectedProjectWorkspaceStorage, projectWorkspaceStorageAdapter } from './adapters/project-workspace-storage-adapter.js';
import {
  downloadWorkerProjectFile,
  resolveWorkerFileAuthorityForHostPath,
  type WorkerFileAuthority,
} from '../runtime-box/workbench-project-file-authority.js';
import type { FileEntry } from '../workspace/file-system.js';

const BINARY_PRESENTATION_EXTENSIONS = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'mp4', 'webm',
  'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'hwp', 'hwpx', 'db', 'sqlite', 'sqlite3', 'dxf', 'dwg',
]);

const PRESENTATION_LANGUAGE: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python',
  md: 'markdown', markdown: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml', html: 'html', htm: 'html', css: 'css',
  sh: 'shell', bash: 'shell', sql: 'sql', rs: 'rust', go: 'go', java: 'java', txt: 'text', rst: 'text', org: 'text',
  csv: 'csv', tsv: 'csv', ipynb: 'json', log: 'text', pdf: 'pdf', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
  webp: 'image', bmp: 'image', ico: 'image', svg: 'image', mp4: 'video', webm: 'video', docx: 'docx', doc: 'docx',
  xlsx: 'xlsx', xls: 'xlsx', pptx: 'pptx', ppt: 'pptx', hwp: 'hwp', hwpx: 'hwp', db: 'sqlite', sqlite: 'sqlite',
  sqlite3: 'sqlite', dxf: 'cad', dwg: 'cad',
};

export interface ProjectWorkspaceFileReference {
  projectId: string;
  projectRoot: string;
  relativePath: string;
  hostPath: string;
  workerAuthority?: WorkerFileAuthority;
}

function normalizeRelativePath(value: string, allowProjectRoot = false): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if ((normalized === '.' && allowProjectRoot) || (normalized && normalized.split('/').every(part => part !== '..'))) {
    return normalized;
  }
  throw new Error('PROJECT_WORKSPACE_FILE_PATH_INVALID');
}

function assertInside(root: string, candidate: string): void {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('PROJECT_WORKSPACE_FILE_PATH_INVALID');
  }
}

export async function resolveProjectWorkspaceFile(input: {
  projectId: string;
  relativePath: string;
  /** Already-authorized registered root; avoids repeating Project lookup in composed access flows. */
  projectRoot?: string;
  /** Directory listing may address the Project root itself as '.'. */
  allowProjectRoot?: boolean;
}): Promise<ProjectWorkspaceFileReference> {
  const projectRoot = input.projectRoot || (await getProject(input.projectId))?.rootPath;
  if (!projectRoot) throw new Error('PROJECT_WORKSPACE_NOT_FOUND');
  const relativePath = normalizeRelativePath(input.relativePath, input.allowProjectRoot);
  const hostPath = relativePath === '.' ? path.resolve(projectRoot) : path.join(projectRoot, relativePath);
  if (relativePath !== '.') assertInside(projectRoot, hostPath);
  const workerAuthority = await resolveWorkerFileAuthorityForHostPath(hostPath, { projectId: input.projectId, projectRoot });
  if (workerAuthority && (workerAuthority.projectId !== input.projectId
    || path.resolve(workerAuthority.projectRoot) !== path.resolve(projectRoot)
    || workerAuthority.relativePath !== relativePath)) throw new Error('PROJECT_WORKSPACE_STORAGE_CHANGED');
  return {
    projectId: input.projectId,
    projectRoot: path.resolve(projectRoot),
    relativePath,
    hostPath,
    ...(workerAuthority ? { workerAuthority } : {}),
  };
}

async function assertCurrentProjectWorkspaceAccess(reference: ProjectWorkspaceFileReference, actorUserId: number, operation: 'read' | 'write' = 'read'): Promise<void> {
  const auth = await getUserAuthState(actorUserId);
  if (!auth || auth.disabled || auth.approvalStatus !== 'active') throw new Error('PROJECT_FILE_SOURCE_ACCESS_REVOKED');
  if (operation === 'write' && (!isTowerRole(auth.role) || isReadOnlyRole(auth.role))) throw new Error('PROJECT_FILE_WRITE_ACCESS_DENIED');
  if (auth.role === 'admin') return;
  const project = await getProject(reference.projectId);
  const allowed = operation === 'write'
    ? await isProjectMember(reference.projectId, actorUserId, 'write')
    : project?.userId === actorUserId || await isProjectMember(reference.projectId, actorUserId);
  if (!allowed) throw new Error('PROJECT_FILE_SOURCE_ACCESS_REVOKED');
}

export async function listProjectWorkspaceDirectory(input: {
  reference: ProjectWorkspaceFileReference;
  actorUserId: number;
  showHidden?: boolean;
  depth?: number;
}): Promise<{ storageAuthority: 'host' | 'worker'; entries: FileEntry[] }> {
  await assertCurrentProjectWorkspaceAccess(input.reference, input.actorUserId);
  const adapter = projectWorkspaceStorageAdapter(input.reference);
  return { storageAuthority: adapter.kind, entries: await adapter.list(input.reference, input.actorUserId, input.showHidden, input.depth) };
}

export async function projectWorkspaceEntryExists(input: {
  reference: ProjectWorkspaceFileReference;
  actorUserId: number;
}): Promise<{ storageAuthority: 'host' | 'worker'; exists: boolean }> {
  await assertCurrentProjectWorkspaceAccess(input.reference, input.actorUserId);
  const adapter = projectWorkspaceStorageAdapter(input.reference);
  return { storageAuthority: adapter.kind, exists: await adapter.exists(input.reference, input.actorUserId) };
}

export async function readProjectWorkspaceFileForPresentation(input: {
  reference: ProjectWorkspaceFileReference;
  actorUserId: number;
  maxBytes?: number;
}): Promise<{ storageAuthority: 'host' | 'worker'; content: string; language: string; encoding?: 'base64' }> {
  const extension = path.extname(input.reference.relativePath).slice(1).toLowerCase();
  const maxBytes = input.maxBytes ?? 200 * 1024 * 1024;
  const adapter = projectWorkspaceStorageAdapter(input.reference);
  const { bytes } = await readProjectWorkspaceFileBytes({ reference: input.reference, actorUserId: input.actorUserId, maxBytes });
  const language = PRESENTATION_LANGUAGE[extension] || (BINARY_PRESENTATION_EXTENSIONS.has(extension) ? 'binary' : 'text');
  if (BINARY_PRESENTATION_EXTENSIONS.has(extension)) {
    return { storageAuthority: input.reference.workerAuthority ? 'worker' : 'host', content: bytes.toString('base64'), language, encoding: 'base64' };
  }
  return { storageAuthority: input.reference.workerAuthority ? 'worker' : 'host', content: bytes.toString('utf8'), language };
}

export async function readProjectWorkspaceFileBytes(input: {
  reference: ProjectWorkspaceFileReference;
  actorUserId: number;
  maxBytes: number;
  expectedStorage?: ExpectedProjectWorkspaceStorage;
}): Promise<{ storageKind: 'host' | 'worker'; bytes: Buffer }> {
  await assertCurrentProjectWorkspaceAccess(input.reference, input.actorUserId);
  assertExpectedStorage(input.reference, input.expectedStorage);
  const adapter = projectWorkspaceStorageAdapter(input.reference);
  return { storageKind: adapter.kind, bytes: await adapter.readBytes(input.reference, input.actorUserId, input.maxBytes) };
}

/** Current direct-user write admission; not a bearer capability or file mutation.
 * Reuses the gateway's policy. Delegated Agent/team grants have a separate entry.
 */
export async function resolveCurrentProjectWorkspaceWrite(input: {
  reference: ProjectWorkspaceFileReference; actorUserId: number;
}): Promise<ProjectWorkspaceFileReference> {
  await assertCurrentProjectWorkspaceAccess(input.reference, input.actorUserId, 'write');
  const current = await resolveProjectWorkspaceFile({ projectId: input.reference.projectId, relativePath: input.reference.relativePath });
  if (current.projectRoot !== input.reference.projectRoot || current.hostPath !== input.reference.hostPath) {
    throw new Error('PROJECT_WORKSPACE_STORAGE_CHANGED');
  }
  assertExpectedStorage(current, input.reference.workerAuthority
    ? { kind: 'worker', workerId: input.reference.workerAuthority.workerId }
    : { kind: 'host' });
  await assertCurrentProjectWorkspaceAccess(current, input.actorUserId, 'write');
  return current;
}

export async function writeProjectWorkspaceText(input: {
  reference: ProjectWorkspaceFileReference;
  actorUserId: number;
  content: string;
  exclusive?: boolean;
}): Promise<'host' | 'worker'> {
  const current = await resolveCurrentProjectWorkspaceWrite(input);
  if (!current.workerAuthority) {
    const target = await resolveCanonicalWriteTarget(current.projectId);
    if (target) {
      const { delegateCanonicalTextWrite } = await import('./canonical-text-delegation.js');
      await delegateCanonicalTextWrite({ ...input, reference: current, target });
      return 'host';
    }
  }
  const adapter = projectWorkspaceStorageAdapter(current);
  await adapter.writeText(current, input.actorUserId, input.content, input.exclusive);
  return adapter.kind;
}

export async function createProjectWorkspaceDirectory(input: {
  reference: ProjectWorkspaceFileReference;
  actorUserId: number;
  exclusive?: boolean;
}): Promise<'host' | 'worker'> {
  await assertCurrentProjectWorkspaceAccess(input.reference, input.actorUserId, 'write');
  const adapter = projectWorkspaceStorageAdapter(input.reference);
  await adapter.mkdir(input.reference, input.actorUserId, input.exclusive);
  return adapter.kind;
}

export async function deleteProjectWorkspaceEntry(input: {
  reference: ProjectWorkspaceFileReference;
  actorUserId: number;
}): Promise<'host' | 'worker'> {
  await assertCurrentProjectWorkspaceAccess(input.reference, input.actorUserId, 'write');
  const adapter = projectWorkspaceStorageAdapter(input.reference);
  await adapter.remove(input.reference, input.actorUserId);
  return adapter.kind;
}

function assertSameProjectStorage(source: ProjectWorkspaceFileReference, target: ProjectWorkspaceFileReference, operation: 'rename' | 'copy'): void {
  const sameProject = source.projectId === target.projectId && path.resolve(source.projectRoot) === path.resolve(target.projectRoot);
  const sameKind = Boolean(source.workerAuthority) === Boolean(target.workerAuthority);
  const sameWorker = !source.workerAuthority || source.workerAuthority.workerId === target.workerAuthority?.workerId;
  if (!sameProject || !sameKind || !sameWorker) throw new Error(`Cannot ${operation} across storage authorities`);
}

export async function renameProjectWorkspaceEntry(input: {
  source: ProjectWorkspaceFileReference;
  target: ProjectWorkspaceFileReference;
  actorUserId: number;
}): Promise<'host' | 'worker'> {
  await assertCurrentProjectWorkspaceAccess(input.source, input.actorUserId, 'write');
  assertSameProjectStorage(input.source, input.target, 'rename');
  const adapter = projectWorkspaceStorageAdapter(input.source);
  await adapter.rename(input.source, input.target, input.actorUserId);
  return adapter.kind;
}

export async function copyProjectWorkspaceEntry(input: {
  source: ProjectWorkspaceFileReference;
  targetDirectory: ProjectWorkspaceFileReference;
  actorUserId: number;
}): Promise<{ storageAuthority: 'host' | 'worker'; targetPath: string }> {
  await assertCurrentProjectWorkspaceAccess(input.source, input.actorUserId, 'write');
  assertSameProjectStorage(input.source, input.targetDirectory, 'copy');
  const adapter = projectWorkspaceStorageAdapter(input.source);
  return { storageAuthority: adapter.kind, targetPath: await adapter.copy(input.source, input.targetDirectory, input.actorUserId) };
}

export async function compareAndSwapProjectWorkspaceText(input: {
  reference: ProjectWorkspaceFileReference;
  actorUserId: number;
  expectedContent: string;
  content: string;
  expectedStorage?: ExpectedProjectWorkspaceStorage;
}): Promise<'host' | 'worker'> {
  await assertCurrentProjectWorkspaceAccess(input.reference, input.actorUserId, 'write');
  assertExpectedStorage(input.reference, input.expectedStorage);
  const adapter = projectWorkspaceStorageAdapter(input.reference);
  await adapter.compareAndSwapText(input.reference, input.actorUserId, input.expectedContent, input.content);
  return adapter.kind;
}

export async function createProjectFileRepresentationSource(input: {
  projectId: string;
  projectRoot: string;
  actorUserId: number;
  actorRole?: string;
}) {
  const referenceFor = async (absolutePath: string) => {
    const root = path.resolve(input.projectRoot);
    const target = path.resolve(absolutePath);
    if (target === root || !target.startsWith(`${root}${path.sep}`)) throw new Error('PROJECT_FILE_SOURCE_OUTSIDE_ROOT');
    return resolveProjectWorkspaceFile({ projectId: input.projectId, projectRoot: root, relativePath: path.relative(root, target).split(path.sep).join('/') });
  };
  return {
    async stat(absolutePath: string) {
      const reference = await referenceFor(absolutePath);
      const result = await statProjectWorkspaceFile({ reference, actorUserId: input.actorUserId });
      return { isFile: () => true, size: result.sizeBytes };
    },
    async readProbe(absolutePath: string, maxBytes: number) {
      const reference = await referenceFor(absolutePath);
      await assertCurrentProjectWorkspaceAccess(reference, input.actorUserId);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error('PROJECT_FILE_PROBE_LIMIT_INVALID');
      return projectWorkspaceStorageAdapter(reference).readProbe(reference, input.actorUserId, maxBytes);
    },
    async readFile(absolutePath: string, maxBytes: number) {
      const reference = await referenceFor(absolutePath);
      return (await readProjectWorkspaceFileBytes({ reference, actorUserId: input.actorUserId, maxBytes })).bytes;
    },
  };
}

export async function statProjectWorkspaceFile(input: {
  reference: ProjectWorkspaceFileReference;
  actorUserId: number;
}): Promise<{ sizeBytes: number; version: string }> {
  await assertCurrentProjectWorkspaceAccess(input.reference, input.actorUserId);
  return projectWorkspaceStorageAdapter(input.reference).stat(input.reference, input.actorUserId);
}

/** Materialize an immutable local snapshot for hashing/copying. Caller must cleanup when provided. */
export async function materializeProjectWorkspaceFile(input: {
  reference: ProjectWorkspaceFileReference;
  actorUserId: number;
  stagingDirectory: string;
}): Promise<{ path: string; cleanup: () => Promise<void>; sizeBytes?: number; version?: string }> {
  await assertCurrentProjectWorkspaceAccess(input.reference, input.actorUserId);
  if (!input.reference.workerAuthority) return { path: input.reference.hostPath, cleanup: async () => undefined };
  const bytes = await downloadWorkerProjectFile({ authority: input.reference.workerAuthority, actorUserId: input.actorUserId, maxBytes: 200 * 1024 * 1024 });
  await fs.mkdir(input.stagingDirectory, { recursive: true });
  const staged = path.join(input.stagingDirectory, `.tower-project-source-${crypto.randomUUID()}.tmp`);
  await fs.writeFile(staged, bytes, { flag: 'wx', mode: 0o600 });
  return {
    path: staged,
    sizeBytes: bytes.length,
    version: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    cleanup: () => fs.rm(staged, { force: true }),
  };
}

/** Commit without overwrite; legacy Worker storage is checked and written only through its authority. */
export async function commitProjectWorkspaceFile(input: {
  projectId: string;
  relativeDirectory: string;
  requestedName: string;
  sourcePath: string;
  sizeBytes: number;
  actorUserId: number;
}): Promise<{ relativePath: string; name: string; compensate: () => Promise<void> }> {
  const safeName = path.basename(input.requestedName).replace(/[\\/:*?"<>|\0]/g, '-').slice(0, 240);
  if (!safeName || safeName === '.' || safeName === '..') throw new Error('PROJECT_WORKSPACE_FILE_NAME_INVALID');
  const directory = input.relativeDirectory.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (directory.split('/').some(part => part === '..')) throw new Error('PROJECT_WORKSPACE_FILE_PATH_INVALID');
  const ext = path.extname(safeName);
  const stem = path.basename(safeName, ext);
  for (let index = 0; index < 10_000; index++) {
    const name = index === 0 ? safeName : `${stem} (${index})${ext}`;
    const relativePath = path.posix.join(directory || 'uploads', name);
    const reference = await resolveProjectWorkspaceFile({ projectId: input.projectId, relativePath });
    await assertCurrentProjectWorkspaceAccess(reference, input.actorUserId, 'write');
    try {
      const compensate = await projectWorkspaceStorageAdapter(reference).importExclusive(
        reference, input.actorUserId, input.sourcePath, input.sizeBytes,
        () => assertCurrentProjectWorkspaceAccess(reference, input.actorUserId, 'write'),
      );
      return { relativePath, name, compensate };
    } catch (error: any) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error('PROJECT_WORKSPACE_FILE_CONFLICT');
}
