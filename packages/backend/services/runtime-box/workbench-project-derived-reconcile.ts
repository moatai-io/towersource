/**
 * Owns: bounded Worker-authoritative rebuild of the host Project derived mirror.
 * Public API: reconcileWorkerProjectDerivedMirror.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  downloadWorkerProjectFile,
  readWorkerProjectManifest,
  type WorkerFileAuthority,
  type WorkerProjectManifestEntry,
} from './workbench-project-file-authority.js';

export interface WorkerDerivedReconcileResult {
  workerId: string;
  subtree: string;
  workerFiles: number;
  workerBytes: number;
  downloaded: number;
  unchanged: number;
  deleted: number;
  directoriesCreated: number;
}

const SKIP_NAMES = new Set(['.git', 'node_modules', '.tower-run-credentials']);

function hostPath(authority: WorkerFileAuthority, workerRelativePath: string): string {
  const root = path.resolve(authority.projectRoot);
  const target = path.resolve(root, ...workerRelativePath.split('/'));
  if (target === root || !target.startsWith(root + path.sep)) throw new Error('WORKER_DERIVED_RECONCILE_PATH_OUTSIDE_PROJECT');
  return target;
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function collectHostEntries(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_NAMES.has(item.name)) continue;
      const fullPath = path.join(dir, item.name);
      entries.push(fullPath);
      if (item.isDirectory() && !item.isSymbolicLink()) walk(fullPath);
    }
  };
  walk(root);
  return entries;
}

/**
 * Rebuild one bounded host subtree from Worker authority. The Worker manifest must
 * complete before any host deletion, so limit failures leave the mirror untouched.
 */
export async function reconcileWorkerProjectDerivedMirror(input: {
  authority: WorkerFileAuthority;
  actorUserId: number;
  maxFiles?: number;
  maxBytes?: number;
}): Promise<WorkerDerivedReconcileResult> {
  const manifest = await readWorkerProjectManifest(input);
  const subtreeRoot = hostPath(input.authority, input.authority.relativePath);
  const workerPaths = new Set(manifest.entries.map(entry => hostPath(input.authority, entry.path)));
  let downloaded = 0;
  let unchanged = 0;
  let directoriesCreated = 0;

  const directories = manifest.entries.filter((entry): entry is WorkerProjectManifestEntry & { type: 'directory' } => entry.type === 'directory');
  directories.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  fs.mkdirSync(subtreeRoot, { recursive: true });
  for (const entry of directories) {
    const target = hostPath(input.authority, entry.path);
    if (!fs.existsSync(target)) directoriesCreated += 1;
    fs.mkdirSync(target, { recursive: true });
  }

  for (const entry of manifest.entries) {
    if (entry.type !== 'file') continue;
    const target = hostPath(input.authority, entry.path);
    if (fs.existsSync(target) && fs.statSync(target).isFile() && entry.sha256 && sha256File(target) === entry.sha256) {
      unchanged += 1;
      continue;
    }
    const relativePath = path.relative(input.authority.projectRoot, target).split(path.sep).join('/');
    const bytes = await downloadWorkerProjectFile({
      authority: { ...input.authority, relativePath },
      actorUserId: input.actorUserId,
    });
    if (entry.sizeBytes !== undefined && bytes.length !== entry.sizeBytes) throw new Error('WORKER_DERIVED_RECONCILE_SIZE_MISMATCH');
    if (entry.sha256 && createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('WORKER_DERIVED_RECONCILE_HASH_MISMATCH');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.tower-derived-reconcile-${process.pid}-${Date.now()}.tmp`;
    await fsp.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
    await fsp.rename(temp, target);
    downloaded += 1;
  }

  let deleted = 0;
  const hostEntries = collectHostEntries(subtreeRoot).sort((a, b) => b.length - a.length);
  for (const entry of hostEntries) {
    if (workerPaths.has(entry)) continue;
    fs.rmSync(entry, { recursive: true, force: true });
    deleted += 1;
  }

  return {
    workerId: input.authority.workerId,
    subtree: input.authority.relativePath,
    workerFiles: manifest.fileCount,
    workerBytes: manifest.totalBytes,
    downloaded,
    unchanged,
    deleted,
    directoriesCreated,
  };
}
