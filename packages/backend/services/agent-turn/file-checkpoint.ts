import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export interface FileSnapshot {
  exists: boolean;
  sha256: string | null;
  content: Buffer | null;
}

export interface CheckpointFileChange {
  filePath: string;
  before: FileSnapshot;
  after: FileSnapshot;
}

export interface RestorePreviewItem {
  filePath: string;
  action: 'create' | 'update' | 'delete' | 'noop';
  status: 'ready' | 'conflict';
  expectedAfterSha256: string | null;
  currentSha256: string | null;
}

export interface RestorePreview {
  previewHash: string;
  items: RestorePreviewItem[];
  canApply: boolean;
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

export function assertCheckpointPath(projectRoot: string, filePath: string): string {
  const root = resolve(projectRoot);
  const candidate = resolve(root, filePath);
  if (!isInside(root, candidate)) throw new Error('checkpoint_path_outside_project');
  if (candidate.includes(`${sep}.git${sep}`) || candidate.endsWith(`${sep}.git`)) {
    throw new Error('checkpoint_path_protected');
  }
  return candidate;
}

export async function snapshotFile(projectRoot: string, filePath: string): Promise<FileSnapshot> {
  const absolutePath = assertCheckpointPath(projectRoot, filePath);
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) throw new Error('checkpoint_path_not_file');
    const content = await readFile(absolutePath);
    return { exists: true, sha256: sha256(content), content };
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { exists: false, sha256: null, content: null };
    throw error;
  }
}

function restoreAction(change: CheckpointFileChange): RestorePreviewItem['action'] {
  if (!change.before.exists && change.after.exists) return 'delete';
  if (change.before.exists && !change.after.exists) return 'create';
  if (change.before.sha256 === change.after.sha256) return 'noop';
  return 'update';
}

function previewDigest(items: RestorePreviewItem[]): string {
  return createHash('sha256').update(JSON.stringify(items.map((item) => ({
    path: item.filePath,
    action: item.action,
    expected: item.expectedAfterSha256,
    current: item.currentSha256,
    status: item.status,
  })))).digest('hex');
}

export async function previewFilesOnlyRestore(
  projectRoot: string,
  changes: CheckpointFileChange[],
): Promise<RestorePreview> {
  const items: RestorePreviewItem[] = [];
  for (const change of [...changes].sort((a, b) => a.filePath.localeCompare(b.filePath))) {
    const filePath = assertCheckpointPath(projectRoot, change.filePath);
    const current = await snapshotFile(projectRoot, filePath);
    const status = current.exists === change.after.exists && current.sha256 === change.after.sha256
      ? 'ready'
      : 'conflict';
    items.push({
      filePath,
      action: restoreAction(change),
      status,
      expectedAfterSha256: change.after.sha256,
      currentSha256: current.sha256,
    });
  }
  return {
    previewHash: previewDigest(items),
    items,
    canApply: items.every((item) => item.status === 'ready'),
  };
}

async function atomicWrite(filePath: string, content: Buffer): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tower-restore-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, content, { flag: 'wx' });
  await rename(tempPath, filePath);
}

export async function applyFilesOnlyRestore(params: {
  projectRoot: string;
  changes: CheckpointFileChange[];
  previewHash: string;
}): Promise<RestorePreview> {
  const preview = await previewFilesOnlyRestore(params.projectRoot, params.changes);
  if (preview.previewHash !== params.previewHash) throw new Error('checkpoint_preview_stale');
  if (!preview.canApply) throw new Error('checkpoint_restore_conflict');

  for (const change of params.changes) {
    const filePath = assertCheckpointPath(params.projectRoot, change.filePath);
    if (!change.before.exists) {
      await rm(filePath, { force: true });
      continue;
    }
    if (!change.before.content || sha256(change.before.content) !== change.before.sha256) {
      throw new Error('checkpoint_before_blob_invalid');
    }
    await atomicWrite(filePath, change.before.content);
  }
  return preview;
}
