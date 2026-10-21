import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { planWorkerRelease } from './workbench-worker-release-plan.js';
import type { ReleaseReceipt, WorkerReleasePorts } from './workbench-worker-release-runner.js';

const phases = new Set(['planned', 'draining', 'switching', 'verifying', 'restoring-drain', 'verified', 'rolling-back', 'rolled-back', 'recovery-required']);
function id(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value)) throw new Error('WORKER_RELEASE_INVALID_STORAGE_ID');
  return value;
}
function receipt(value: ReleaseReceipt): ReleaseReceipt {
  id(value.runId); id(value.before.workerId);
  if (!phases.has(value.phase)) throw new Error('WORKER_RELEASE_INVALID_PHASE');
  planWorkerRelease(value.targetStore, [value.before.workerId], [value.before]);
  // Explicit projection: do not persist arbitrary fields (including credentials).
  const b = value.before;
  return { runId: value.runId, targetStore: value.targetStore, phase: value.phase,
    before: { workerId: b.workerId, configuredStore: b.configuredStore, liveStore: b.liveStore, activeRuns: b.activeRuns, draining: b.draining } };
}
async function syncDir(root: string) {
  const handle = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
/** root must be provisioned by trusted bootstrap, with trusted non-writable ancestors.
 * A crashed process leaves the lock behind. No PID/age-based automatic lock stealing. */
export async function createWorkerReleaseStore(root: string): Promise<Pick<WorkerReleasePorts, 'load' | 'save' | 'exclusive'>> {
  if (!path.isAbsolute(root)) throw new Error('WORKER_RELEASE_ABSOLUTE_ROOT_REQUIRED');
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error('WORKER_RELEASE_PRIVATE_ROOT_REQUIRED');
  }
  let lockedWorker: string | undefined;
  const assertLock = (worker: string) => {
    if (lockedWorker !== worker) throw new Error('WORKER_RELEASE_LOCK_REQUIRED');
  };
  const store: Pick<WorkerReleasePorts, 'load' | 'save' | 'exclusive'> = {
    async exclusive(workerId, body) {
      id(workerId);
      if (lockedWorker) throw new Error('WORKER_RELEASE_STORE_BUSY');
      const lock = path.join(root, `worker-${workerId}.lock`);
      await fs.mkdir(lock, { mode: 0o700 });
      // Failure to persist lock must fail closed, retaining the lock for review.
      await syncDir(root);
      lockedWorker = workerId;
      let completed = false;
      try {
        const result = await body();
        // Retain a durable lock on ambiguous persistence or recovery-required outcomes.
        const files = (await fs.readdir(root)).filter(name => name.startsWith(`worker-${workerId}-run-`) && name.endsWith('.json'));
        for (const file of files) {
          const runId = file.slice(`worker-${workerId}-run-`.length, -5);
          const saved = await store.load(runId);
          if (!saved || !['verified', 'rolled-back'].includes(saved.phase)) return result;
        }
        completed = true;
        return result;
      }
      finally {
        lockedWorker = undefined;
        if (completed) {
          await fs.rmdir(lock);
          await syncDir(root);
        }
      }
    },
    async load(runId) {
      if (!lockedWorker) throw new Error('WORKER_RELEASE_LOCK_REQUIRED');
      const file = path.join(root, `worker-${id(lockedWorker)}-run-${id(runId)}.json`);
      let handle;
      try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0) throw new Error('WORKER_RELEASE_INVALID_RECEIPT_FILE');
        const result = receipt(JSON.parse(await handle.readFile('utf8')));
        if (result.runId !== runId) throw new Error('WORKER_RELEASE_RECEIPT_CONFLICT');
        assertLock(result.before.workerId);
        return result;
      } finally { await handle.close(); }
    },
    async save(value) {
      const clean = receipt(value);
      assertLock(clean.before.workerId);
      // Include Worker identity in deployment-level run IDs; refuse cross-worker reuse.
      const prior = await store.load(clean.runId);
      if (prior && (prior.targetStore !== clean.targetStore || JSON.stringify(prior.before) !== JSON.stringify(clean.before))) {
        throw new Error('WORKER_RELEASE_RECEIPT_CONFLICT');
      }
      const file = path.join(root, `worker-${clean.before.workerId}-run-${clean.runId}.json`);
      const temporary = path.join(root, `.receipt-${randomUUID()}`);
      const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(JSON.stringify(clean) + '\n');
        await handle.sync();
      } finally { await handle.close(); }
      // A failed write/rename may leave a private temporary file; never delete unknown paths.
      await fs.rename(temporary, file);
      await syncDir(root);
    },
  };
  return store;
}
