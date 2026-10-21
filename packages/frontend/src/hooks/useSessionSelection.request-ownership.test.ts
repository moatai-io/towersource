import { expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync('packages/frontend/src/hooks/useSessionSelection.ts', 'utf8');
afterEach(() => vi.useRealTimers());
it('registers cold loads with cancellation and the existing ten-second deadline', () => {
  vi.useFakeTimers();
  const start = source.indexOf('    const controller = new AbortController();');
  const end = source.indexOf('\n    try {', start);
  const ref = { current: null as AbortController | null };
  new Function('refreshControllerRef', ts.transpile(source.slice(start, end)))(ref);
  expect(ref.current).toBeInstanceOf(AbortController);
  vi.advanceTimersByTime(10000);
  expect(ref.current?.signal.aborted).toBe(true);
});
it('old request cleanup cannot stop a newer selection loading indicator', () => {
  const start = source.indexOf('    } finally {', source.indexOf('    const controller = new AbortController();'));
  const end = source.indexOf('\n    // No synthetic', start);
  const body = source.slice(start + '    } finally {'.length, end).replace(/\}\s*$/, '');
  const old = new AbortController(), newer = new AbortController();
  const ref = { current: newer as AbortController | null };
  const loading = vi.fn();
  const run = new Function('refreshControllerRef', 'controller', 'timeoutId', 'session', 'useSessionStore', 'useChatStore', ts.transpile(body));
  const args = [undefined, { id: 'a' }, { getState: () => ({ activeSessionId: 'a' }) }, { getState: () => ({ sessionId: 'a', setSessionLoading: loading }) }];
  run(ref, old, ...args); expect(loading).not.toHaveBeenCalled(); expect(ref.current).toBe(newer);
  run(ref, newer, ...args); expect(loading).toHaveBeenCalledWith(false); expect(ref.current).toBeNull();
});
