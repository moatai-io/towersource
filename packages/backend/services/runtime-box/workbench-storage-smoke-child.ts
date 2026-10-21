/** Dedicated unprivileged filesystem probe. Transport credentials stay in parent. */
import { enterBackendStorageIdentity, verifyBackendProcessIdentity, type BackendStorageIdentity } from './workbench-storage-smoke-identity.js';
import { verifySharedProjectStorage } from './workbench-project-shared-storage-smoke.js';
let started = false;
let sequence = 0;
const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
function call(op: string, args: string[]): Promise<void> {
  const id = ++sequence;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); process.send!({ type: 'request', id, op, args }); });
}
process.on('message', async (message: any) => {
  if (message?.type === 'reply') {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.ok) waiter?.resolve(); else waiter?.reject(new Error('SHARED_STORAGE_REMOTE_PROBE_FAILED'));
    return;
  }
  if (started || message?.type !== 'start') return;
  started = true;
  try {
    const identity = message.identity as BackendStorageIdentity;
    enterBackendStorageIdentity(identity);
    verifyBackendProcessIdentity(process.pid, identity);
    await verifySharedProjectStorage({ root: message.root, backendUid: identity.uid,
      execute: command => call('execute', [command]), upload: (relative, content) => call('upload', [relative, content]),
    });
    process.send!({ type: 'complete', ok: true }, () => process.disconnect!());
  } catch {
    // Never return paths, command payloads or provider output over diagnostics.
    process.send!({ type: 'complete', ok: false }, () => process.disconnect!());
    process.exitCode = 1;
  }
});
process.on('disconnect', () => { if (pending.size) process.exit(1); });
