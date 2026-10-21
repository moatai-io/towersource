import { generateKeyPairSync } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createWorkstationLaunchDispatcher } from './workstation-launch-dispatch.js';
import { createWorkstationLaunchVerifier, signWorkstationLaunch } from './workstation-launch-authorization.js';
const keys = generateKeyPairSync('ed25519');
function fixture() {
  const cleanup = vi.fn().mockResolvedValue(undefined);
  const prepare = vi.fn().mockResolvedValue({ env: { DEMO: 'synthetic' }, cleanup });
  const run = vi.fn().mockResolvedValue({ exitCode: 0 });
  const identity = vi.fn(() => ({ uid: 31001, gid: 31001, groups: [31001] }));
  const dispatch = createWorkstationLaunchDispatcher({
    policy: { projectId: 'a', uid: 31001, gid: 31001, home: '/home/demo', projectRoot: '/project' },
    controllerUid: 31002, identity,
    verify: createWorkstationLaunchVerifier({ publicKey: keys.publicKey, instanceId: 'instance', projectId: 'a' }), prepare, run,
  });
  const request = (changes = {}) => signWorkstationLaunch({ version: 1, requestId: 'request', instanceId: 'instance', projectId: 'a', issuedAt: Date.now(), expiresAt: Date.now() + 30000,
    payload: JSON.stringify({ command: 'pwd', cwd: '.', timeoutSec: 10, credentials: { DEMO: 'synthetic' }, ...changes }) }, keys.privateKey);
  return { dispatch, request, prepare, cleanup, run, identity };
}
it('connects signed authorization, installed identity, preparation, execution and cleanup', async () => {
  const f = fixture(); const request = f.request();
  await expect(f.dispatch(request, new AbortController().signal)).resolves.toEqual({ exitCode: 0 });
  expect(f.run).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/project', home: '/home/demo', env: { DEMO: 'synthetic' } }));
  expect(f.cleanup).toHaveBeenCalledOnce();
  await expect(f.dispatch(request, new AbortController().signal)).rejects.toThrow('ALREADY_CONSUMED');
  expect(f.run).toHaveBeenCalledOnce();
});
it.each([{ uid: 0 }, { cwd: '../other' }, { credentials: { INVALID: { secret: 'sentinel' } } }])('rejects malformed payload without exposing its content', async changes => {
  const f = fixture();
  await expect(f.dispatch(f.request(changes), new AbortController().signal)).rejects.toThrow(/^LAUNCH_PAYLOAD_INVALID$/);
  expect(f.prepare).not.toHaveBeenCalled();
});
it('rejects actual identity mismatch before materialization', async () => {
  const f = fixture(); f.identity.mockReturnValue({ uid: 0, gid: 0, groups: [] });
  await expect(f.dispatch(f.request(), new AbortController().signal)).rejects.toThrow('IDENTITY_MISMATCH');
  expect(f.prepare).not.toHaveBeenCalled();
});
it('cleans on execution failure', async () => {
  const f = fixture(); f.run.mockRejectedValue(new Error('launch failed'));
  await expect(f.dispatch(f.request(), new AbortController().signal)).rejects.toThrow('LAUNCH_EXECUTION_FAILED');
  expect(f.cleanup).toHaveBeenCalledOnce();
});
it('does not prepare a pre-cancelled launch', async () => {
  const f = fixture(); const abort = new AbortController(); abort.abort();
  await expect(f.dispatch(f.request(), abort.signal)).rejects.toThrow('CANCELLED');
  expect(f.prepare).not.toHaveBeenCalled();
});
it('cleans if cancelled during preparation', async () => {
  const f = fixture(); const abort = new AbortController();
  f.prepare.mockImplementation(async () => { abort.abort(); return { env: {}, cleanup: f.cleanup }; });
  await expect(f.dispatch(f.request(), abort.signal)).rejects.toThrow('CANCELLED');
  expect(f.run).not.toHaveBeenCalled(); expect(f.cleanup).toHaveBeenCalledOnce();
});
it('does not report success when cleanup fails', async () => {
  const f = fixture(); f.cleanup.mockRejectedValue(new Error('cleanup failed'));
  await expect(f.dispatch(f.request(), new AbortController().signal)).rejects.toThrow('LAUNCH_CLEANUP_FAILED');
});

it('runs a real child across signed dispatch and retains project files after cleanup (same-UID plumbing only)', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFile } = await import('node:child_process');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-launch-dispatch-'));
  try {
    const credentialPath = path.join(root, 'run-input');
    const uid = process.getuid!(); const gid = process.getgid!();
    // Identity input is synthetic: this test does NOT prove controller isolation.
    const dispatch = createWorkstationLaunchDispatcher({
      policy: { projectId: 'a', uid, gid, home: root, projectRoot: root },
      controllerUid: uid + 1, identity: () => ({ uid, gid, groups: [gid] }),
      verify: createWorkstationLaunchVerifier({ publicKey: keys.publicKey, instanceId: 'os-test', projectId: 'a' }),
      prepare: async credentials => {
        await fs.writeFile(credentialPath, credentials.DEMO, { mode: 0o600 });
        return { env: { INPUT_FILE: credentialPath }, cleanup: () => fs.unlink(credentialPath) };
      },
      run: input => new Promise<string>((resolve, reject) => {
        execFile('/bin/sh', ['-c', input.command], {
          cwd: input.cwd, env: { HOME: input.home, ...input.env }, signal: input.signal,
          timeout: input.timeoutSec * 1000, maxBuffer: 4096,
        }, (error, stdout) => error ? reject(error) : resolve(stdout));
      }),
    });
    for (const [index, command] of [
      'test -r "$INPUT_FILE" && printf retained > output.txt && printf ready',
      'test -f output.txt && test -r "$INPUT_FILE" && printf retained',
    ].entries()) {
      const request = signWorkstationLaunch({ version: 1, projectId: 'a', instanceId: 'os-test', requestId: `run-${index}`,
        issuedAt: Date.now(), expiresAt: Date.now() + 30000,
        payload: JSON.stringify({ command, cwd: '.', timeoutSec: 5, credentials: { DEMO: 'synthetic-only' } }),
      }, keys.privateKey);
      expect(await dispatch(request, new AbortController().signal)).toBe(index === 0 ? 'ready' : 'retained');
      await expect(fs.stat(credentialPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    // exec replaces the shell, so this verifies child cancellation, NOT descendant-group containment.
    const abort = new AbortController();
    const cancelRequest = signWorkstationLaunch({ version: 1, projectId: 'a', instanceId: 'os-test', requestId: 'cancel-run',
      issuedAt: Date.now(), expiresAt: Date.now() + 30000,
      payload: JSON.stringify({ command: 'exec /bin/sleep 10', cwd: '.', timeoutSec: 5, credentials: { DEMO: 'synthetic-only' } }),
    }, keys.privateKey);
    const cancelled = dispatch(cancelRequest, abort.signal);
    const timer = setTimeout(() => abort.abort(), 100);
    try { await expect(cancelled).rejects.toThrow('LAUNCH_CANCELLED'); }
    finally { clearTimeout(timer); }
    await expect(fs.stat(credentialPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(root, 'output.txt'), 'utf8')).toBe('retained');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('preserves both failure stages without returning adapter secrets', async () => {
  const f = fixture();
  f.run.mockRejectedValue(new Error('synthetic-secret-in-command'));
  f.cleanup.mockRejectedValue(new Error('synthetic-secret-in-path'));
  await expect(f.dispatch(f.request(), new AbortController().signal)).rejects.toThrow(/^LAUNCH_EXECUTION_AND_CLEANUP_FAILED$/);
  expect(f.cleanup).toHaveBeenCalledOnce();
});
it('redacts preparation failure and leaves rollback with the preparing adapter', async () => {
  const f = fixture(); f.prepare.mockRejectedValue(new Error('synthetic-secret'));
  await expect(f.dispatch(f.request(), new AbortController().signal)).rejects.toThrow(/^LAUNCH_PREPARATION_FAILED$/);
  expect(f.run).not.toHaveBeenCalled(); expect(f.cleanup).not.toHaveBeenCalled();
});
