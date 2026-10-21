import { expect, it } from 'vitest';
import { runWorkerRelease, type WorkerReleasePorts, type ReleaseReceipt } from './workbench-worker-release-runner.js';
const old = '/nix/store/' + 'a'.repeat(32) + '-old';
const target = '/nix/store/' + 'b'.repeat(32) + '-new';
function fixture() {
  const calls: string[] = [];
  let receipt: ReleaseReceipt | undefined;
  let drain = false;
  const ports: WorkerReleasePorts = {
    exclusive: async (_, body) => body(),
    load: async () => receipt,
    save: async r => { calls.push('save:' + r.phase); receipt = structuredClone(r); },
    inspect: async () => ({ workerId: 'worker', configuredStore: old, liveStore: old, activeRuns: 0, draining: drain }),
    setDrain: async (_, value) => { calls.push('drain:' + value); drain = value; },
    waitQuiescent: async () => true,
    switchArtifact: async () => { calls.push('switch'); },
    verify: async () => true,
    restore: async () => { calls.push('restore'); return true; },
  };
  const input = { runId: 'run-1', workerId: 'worker', targetStore: target, signal: new AbortController().signal };
  return { ports, input, calls };
}
it('persists intent before actions and does not replay terminal runs', async () => {
  const f = fixture();
  expect((await runWorkerRelease(f.input, f.ports)).phase).toBe('verified');
  expect(f.calls.indexOf('save:draining')).toBeLessThan(f.calls.indexOf('drain:true'));
  expect(f.calls.indexOf('save:switching')).toBeLessThan(f.calls.indexOf('switch'));
  expect(f.calls).toContain('drain:false');
  const count = f.calls.length;
  await runWorkerRelease(f.input, f.ports);
  expect(f.calls.length).toBe(count);
});
it('rolls back without switching when activity does not drain', async () => {
  const f = fixture(); f.ports.waitQuiescent = async () => false;
  expect((await runWorkerRelease(f.input, f.ports)).phase).toBe('rolled-back');
  expect(f.calls).not.toContain('switch');
  expect(f.calls).not.toContain('restore');
  expect(f.calls.indexOf('save:rolling-back')).toBeLessThan(f.calls.lastIndexOf('drain:false'));
});
it('requires manual recovery on restore failure', async () => {
  const f = fixture(); f.ports.verify = async () => false; f.ports.restore = async () => false;
  expect((await runWorkerRelease(f.input, f.ports)).phase).toBe('recovery-required');
});
it('does not blindly replay a crash-interrupted switch', async () => {
  const f = fixture();
  f.ports.load = async () => ({ runId: 'run-1', targetStore: target, before: await f.ports.inspect('worker'), phase: 'switching' });
  expect((await runWorkerRelease(f.input, f.ports)).phase).toBe('recovery-required');
  expect(f.calls).toEqual(['save:recovery-required']);
});
it('does not mutate if initial journal persistence fails', async () => {
  const f = fixture(); f.ports.save = async () => { throw new Error('disk full'); };
  await expect(runWorkerRelease(f.input, f.ports)).rejects.toThrow('disk full');
  expect(f.calls).toEqual([]);
});
it('does not perform an unjournaled switch', async () => {
  const f = fixture(); const save = f.ports.save;
  f.ports.save = async r => { if (r.phase === 'switching') throw new Error('disk full'); await save(r); };
  expect((await runWorkerRelease(f.input, f.ports)).phase).toBe('rolled-back');
  expect(f.calls).not.toContain('switch');
});
