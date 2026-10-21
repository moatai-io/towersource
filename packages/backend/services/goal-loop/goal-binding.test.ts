import { describe, it, expect, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createGoalTurnBinding } from './goal-binding';
function fixture() {
  let root: string | undefined = 'r1';
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: undefined }));
  const tool: ToolDefinition = { name: 'goal_status', label: 'goal', description: 'test', parameters: Type.Object({}), execute };
  const runtime = { tools: [tool], afterInvocation: vi.fn(async () => ({ invocations: 1, reason: 'completed' })) };
  const bridge = createGoalTurnBinding('session', () => root);
  return { bridge, runtime, execute, proxy: bridge.proxy(tool), setRoot: (value?: string) => { root = value; } };
}
describe('cached goal tool root binding', () => {
  it('rejects calls without binding', async () => { const f = fixture(); expect((await f.proxy.execute('x', {})).isError).toBe(true); expect(f.execute).not.toHaveBeenCalled(); });
  it('resolves current binding and rejects previous root', async () => {
    const f = fixture(); f.bridge.bind('r1', f.runtime); await f.proxy.execute('x', {}); expect(f.execute).toHaveBeenCalledTimes(1);
    f.setRoot('r2'); expect((await f.proxy.execute('x', {})).isError).toBe(true); expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('cleanup for old binding cannot clear newer binding', async () => {
    const f = fixture(); const release = f.bridge.bind('r1', f.runtime); release(); f.setRoot('r2'); f.bridge.bind('r2', f.runtime); release();
    await f.proxy.execute('x', {}); expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('disposal closes tools and continuation', async () => {
    const f = fixture(); f.bridge.bind('r1', f.runtime); f.bridge.dispose();
    expect((await f.proxy.execute('x', {})).isError).toBe(true);
    expect((await f.bridge.afterInvocation(new AbortController().signal)).invocations).toBe(0);
  });
  it('rejects root replacement while a tool is still running and suppresses stale result', async () => {
    const f = fixture(); let resolve!: (value: any) => void;
    f.execute.mockImplementation(() => new Promise(r => { resolve = r; }));
    const release = f.bridge.bind('r1', f.runtime); const pending = f.proxy.execute('x', {});
    release(); f.setRoot('r2'); expect(() => f.bridge.bind('r2', f.runtime)).toThrow('GOAL_BINDING_REJECTED');
    resolve({ content: [{ type: 'text', text: 'old result' }], details: undefined });
    expect((await pending).isError).toBe(true);
    expect(() => f.bridge.bind('r2', f.runtime)).not.toThrow();
  });
});
it('release cancels continuation and blocks rebinding until it returns', async () => {
  const f = fixture(); let finish!: () => void; let received: AbortSignal | undefined;
  f.runtime.afterInvocation = vi.fn(async (signal?: AbortSignal) => {
    received = signal;
    await new Promise<void>(resolve => { finish = resolve; });
    return { invocations: 0, reason: 'cancelled' };
  });
  const release = f.bridge.bind('r1', f.runtime);
  const pending = f.bridge.afterInvocation(new AbortController().signal);
  release(); expect(received?.aborted).toBe(true);
  f.setRoot('r2'); expect(() => f.bridge.bind('r2', f.runtime)).toThrow('GOAL_BINDING_REJECTED');
  finish(); await pending; expect(() => f.bridge.bind('r2', f.runtime)).not.toThrow();
});
