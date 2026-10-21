/**
 * Owns: same-filesystem Backend/Worker access verification for automatic local
 * shared-Worker assignment. Not an isolated/remote Worker provisioning policy.
 * Never repairs ACLs or inspects user files; uses only a fresh synthetic subtree.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface SharedStorageSmokeInput {
  root: string;
  /** Explicit backend service identity, not a DB user or an inferred root owner. */
  backendUid: number;
  execute(command: string): Promise<void>;
  /** Exercise the actual HTTP upload endpoint when static file scope is ready. */
  upload(relativePath: string, content: string): Promise<void>;
}

function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

/** Must run in the Backend service identity, including its supplementary groups. */
export function assertSharedStorageSmokeIdentity(backendUid: number): void {
  if (!Number.isSafeInteger(backendUid) || backendUid <= 0) throw new Error('SHARED_STORAGE_BACKEND_UID_REQUIRED');
  if (typeof process.getuid !== 'function' || process.getuid() !== backendUid) {
    throw new Error('SHARED_STORAGE_SMOKE_REQUIRES_BACKEND_SERVICE_IDENTITY');
  }
}

export async function verifySharedProjectStorage(input: SharedStorageSmokeInput): Promise<void> {
  assertSharedStorageSmokeIdentity(input.backendUid);
  const relative = `.tower-assignment-storage-${randomUUID()}`;
  const root = path.resolve(input.root);
  if (!(await fs.lstat(root)).isDirectory() || await fs.realpath(root) !== root) {
    throw new Error('SHARED_STORAGE_ROOT_MUST_BE_REAL_DIRECTORY');
  }
  const probe = path.join(root, relative);
  const marker = randomUUID();
  // Deliberately ordinary mkdir, not mkdtemp(0700): this is synthetic shared
  // business data and must exercise the provisioned default inheritance.
  await fs.mkdir(probe);
  try {
    await fs.writeFile(path.join(probe, 'backend.txt'), marker, { flag: 'wx' });
    await input.execute([
      'set -eu',
      `test "$(cat ${quote(`${relative}/backend.txt`)})" = ${quote(marker)}`,
      `printf %s ${quote('-worker')} >> ${quote(`${relative}/backend.txt`)}`,
      `mkdir ${quote(`${relative}/worker-dir`)}`,
      `printf %s ${quote(marker)} > ${quote(`${relative}/worker-dir/worker.txt`)}`,
    ].join('\n'));
    if (await fs.readFile(path.join(probe, 'backend.txt'), 'utf8') !== `${marker}-worker`) {
      throw new Error('SHARED_STORAGE_WORKER_WRITE_FAILED');
    }
    const workerFile = path.join(probe, 'worker-dir/worker.txt');
    if (await fs.readFile(workerFile, 'utf8') !== marker) throw new Error('SHARED_STORAGE_BACKEND_READ_FAILED');
    await fs.appendFile(workerFile, '-backend');
    await fs.writeFile(path.join(probe, 'worker-dir/backend-child.txt'), marker, { flag: 'wx' });
    await input.upload(`${relative}/worker-dir/upload/new.txt`, marker);
    const uploaded = path.join(probe, 'worker-dir/upload/new.txt');
    if (await fs.readFile(uploaded, 'utf8') !== marker) throw new Error('SHARED_STORAGE_UPLOAD_READ_FAILED');
    await fs.appendFile(uploaded, '-backend');
    await input.execute([
      'set -eu',
      `test "$(cat ${quote(`${relative}/worker-dir/worker.txt`)})" = ${quote(`${marker}-backend`)}`,
      `test "$(cat ${quote(`${relative}/worker-dir/backend-child.txt`)})" = ${quote(marker)}`,
      `test "$(cat ${quote(`${relative}/worker-dir/upload/new.txt`)})" = ${quote(`${marker}-backend`)}`,
      `printf %s ${quote('-worker')} >> ${quote(`${relative}/worker-dir/upload/new.txt`)}`,
    ].join('\n'));
    if (await fs.readFile(uploaded, 'utf8') !== `${marker}-backend-worker`) throw new Error('SHARED_STORAGE_UPLOAD_WRITE_FAILED');
  } finally {
    // Only this run's unpredictable synthetic subtree; no project-wide cleanup.
    await fs.rm(probe, { recursive: true, force: true });
  }
}
