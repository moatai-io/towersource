import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import type { SharedStorageSmokeInput } from './workbench-project-shared-storage-smoke.js';
import { assertBackendStorageIdentity, validateBackendStorageIdentity, type BackendStorageIdentity } from './workbench-storage-smoke-identity.js';

/** Installation supplies the actual Backend service UID/GID/groups/umask. */
export async function runBackendStorageSmoke(input: Omit<SharedStorageSmokeInput, 'backendUid'> & { identity: BackendStorageIdentity }): Promise<void> {
  validateBackendStorageIdentity(input.identity);
  if (process.getuid!() !== 0) assertBackendStorageIdentity(input.identity);
  // Use the installed sibling module; never a Project-selected executable.
  const module = new URL(`./workbench-storage-smoke-child.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url);
  const child = fork(module, [], { cwd: '/', env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: import.meta.url.endsWith('.ts') ? ['--import', createRequire(import.meta.url).resolve('tsx')] : [],
  });
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => finish(new Error('SHARED_STORAGE_CHILD_TIMEOUT')), 110_000);
    function finish(error?: Error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve();
    }
    child.on('error', () => finish(new Error('SHARED_STORAGE_CHILD_START_FAILED')));
    child.on('exit', () => { if (!done) finish(new Error('SHARED_STORAGE_CHILD_EXITED')); });
    child.on('message', async (message: any) => {
      if (message?.type === 'complete') return finish(message.ok ? undefined : new Error('SHARED_STORAGE_BACKEND_PROBE_FAILED'));
      if (message?.type !== 'request' || !Number.isSafeInteger(message.id) || !Array.isArray(message.args)
        || !message.args.every((arg: unknown) => typeof arg === 'string') || done) return;
      try {
        if (message.op === 'execute' && message.args.length === 1) await input.execute(message.args[0]);
        else if (message.op === 'upload' && message.args.length === 2) await input.upload(message.args[0], message.args[1]);
        else throw new Error('invalid request');
        if (child.connected) child.send({ type: 'reply', id: message.id, ok: true });
      } catch { if (child.connected) child.send({ type: 'reply', id: message.id, ok: false }); }
    });
    child.send({ type: 'start', root: input.root, identity: input.identity });
  });
}
