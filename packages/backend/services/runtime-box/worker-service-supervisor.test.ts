import { describe, it, expect, vi } from 'vitest';
import { WorkerServiceSupervisor, type SupervisedServiceChild } from './worker-service-supervisor.js';
function child() {
  let exit!: (value: { code: number | null }) => void;
  const exited = new Promise<{ code: number | null }>(resolve => { exit = resolve; });
  const handle: SupervisedServiceChild = { exited, terminate: vi.fn(), kill: vi.fn(() => exit({ code: 137 })) };
  return { handle, exit };
}
describe('Worker service ownership', () => {
  it('reserves starts before launch and scopes identical service IDs by Project', async () => {
    const supervisor = new WorkerServiceSupervisor(1);
    const a = child(); const b = child();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = supervisor.start('a', 'web', async () => { await gate; return a.handle; });
    await expect(supervisor.start('a', 'web', async () => b.handle)).rejects.toThrow('ALREADY_ACTIVE');
    await supervisor.start('b', 'web', async () => b.handle);
    release(); await first;
    await supervisor.stop('a', 'web');
    expect(a.handle.kill).toHaveBeenCalledOnce();
    expect(b.handle.terminate).not.toHaveBeenCalled();
    await supervisor.shutdown();
  });
  it('does not kill an exited child and returns detached status snapshots', async () => {
    const supervisor = new WorkerServiceSupervisor(1); const a = child();
    await supervisor.start('a', 'web', async () => a.handle);
    supervisor.status('a', 'web')!.state = 'failed';
    expect(supervisor.status('a', 'web')!.state).toBe('running');
    a.exit({ code: 0 }); await a.handle.exited;
    await supervisor.stop('a', 'web');
    expect(a.handle.kill).not.toHaveBeenCalled();
    expect(a.handle.terminate).not.toHaveBeenCalled();
  });
  it('waits for starting children during shutdown and rejects new starts', async () => {
    const supervisor = new WorkerServiceSupervisor(1); const a = child();
    let resolve!: (value: SupervisedServiceChild) => void;
    const start = supervisor.start('a', 'web', () => new Promise(r => { resolve = r; }));
    const closing = supervisor.shutdown();
    await expect(supervisor.start('b', 'web', async () => a.handle)).rejects.toThrow('CLOSING');
    resolve(a.handle); await start; await closing;
    expect(supervisor.status('a', 'web')?.state).toBe('exited');
  });
  it('deduplicates stop and cancels escalation on graceful exit', async () => {
    const supervisor = new WorkerServiceSupervisor(10); const a = child();
    a.handle.terminate = vi.fn(() => a.exit({ code: 0 }));
    await supervisor.start('a', 'web', async () => a.handle);
    await Promise.all([supervisor.stop('a', 'web'), supervisor.stop('a', 'web')]);
    expect(a.handle.terminate).toHaveBeenCalledOnce();
    expect(a.handle.kill).not.toHaveBeenCalled();
  });
  it('records failed launch and allows retry', async () => {
    const supervisor = new WorkerServiceSupervisor(1); const a = child();
    await expect(supervisor.start('a', 'web', async () => { throw new Error('launch'); })).rejects.toThrow('launch');
    expect(supervisor.status('a', 'web')?.state).toBe('failed');
    await supervisor.start('a', 'web', async () => a.handle);
    await supervisor.shutdown();
  });
});
