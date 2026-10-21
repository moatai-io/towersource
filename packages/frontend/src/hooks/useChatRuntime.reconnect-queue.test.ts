import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync('packages/frontend/src/hooks/useChatRuntime.ts', 'utf8');
const start = source.indexOf('        const reconnectGeneration =');
const end = source.indexOf('        }, 3000);', start) + '        }, 3000);'.length;
const code = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 });
afterEach(() => vi.useRealTimers());
function setup() {
  vi.useFakeTimers();
  const epoch = { current: 1 };
  const ws = { current: { readyState: 1 } };
  const dequeue = vi.fn(() => 'queued question');
  const send = vi.fn();
  const sessions = { streamingSessions: new Set<string>(), sessions: [{ id: 'background' }] };
  const chat = { messageQueue: { background: ['queued question'] }, sessionId: 'active', dequeueMessage: dequeue };
  new Function('lastConnectTs', 'wsRef2', 'WebSocket', 'useSessionStore', 'useChatStore', 'sendRef', 'generateUUID', 'effectiveModelForSend', 'markSessionRunActive', code)(epoch, ws, { OPEN: 1 }, { getState: () => sessions }, { getState: () => chat }, { current: send }, () => 'id', () => 'model', vi.fn());
  return { epoch, ws, dequeue, send, sessions };
}
it('uses current streaming state, not the state at connection time', () => {
  const s = setup(); s.sessions.streamingSessions.add('background');
  vi.advanceTimersByTime(3000);
  expect(s.dequeue).not.toHaveBeenCalled();
});
it.each(['replaced', 'closed', 'missing'] as const)('preserves input when connection/session is %s', kind => {
  const s = setup();
  if (kind === 'replaced') s.epoch.current++;
  if (kind === 'closed') s.ws.current.readyState = 3;
  if (kind === 'missing') s.sessions.sessions = [];
  vi.advanceTimersByTime(3000);
  expect(s.dequeue).not.toHaveBeenCalled(); expect(s.send).not.toHaveBeenCalled();
});
it('sends the queued message once when the background session is idle and connected', () => {
  const s = setup(); vi.advanceTimersByTime(6000);
  expect(s.dequeue).toHaveBeenCalledExactlyOnceWith('background');
  expect(s.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'chat', sessionId: 'background', message: 'queued question' }));
});
