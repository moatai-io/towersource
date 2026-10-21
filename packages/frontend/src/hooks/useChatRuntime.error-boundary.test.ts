import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import ts from 'typescript';
import { shouldDropSessionMessage } from '../utils/session-filters';
const source = fs.readFileSync('packages/frontend/src/hooks/useChatRuntime.ts', 'utf8');
const start = source.indexOf("      case 'error': {");
const end = source.indexOf("      case 'resume_failed':", start);
const body = ts.transpile(`switch (data.type) { ${source.slice(start, end)} }`);
function run(incoming: string | undefined, active: string | null) {
  const setStreaming = vi.fn(), finish = vi.fn(), toast = vi.fn(), setCompacting = vi.fn();
  const requestFailure = vi.fn();
  const env = { reportChatRequestFailure: requestFailure, data: { type: 'error', sessionId: incoming }, useChatStore: { getState: () => ({ sessionId: active, setCompacting }) }, useSessionStore: { getState: () => ({ activeSessionId: active }) }, shouldDropSessionMessage, setStreaming, markSessionRunFinished: finish, presentChatRuntimeError: () => ({ message: 'run error', tone: 'error' }), currentAssistantMsg: { current: {} }, toastError: toast, toastWarning: vi.fn(), i18n: { t: () => 'operation error' } };
  new Function(...Object.keys(env), body)(...Object.values(env));
  return { setStreaming, finish, toast, setCompacting, requestFailure };
}
it.each([null, 'active'])('unscoped errors preserve run state with active session %s', active => {
  const r = run(undefined, active);
  expect(r.toast).not.toHaveBeenCalled();
  expect(r.requestFailure).toHaveBeenCalledWith(active);
  expect(r.setStreaming).not.toHaveBeenCalled(); expect(r.finish).not.toHaveBeenCalled(); expect(r.setCompacting).not.toHaveBeenCalled();
});
it('ignores background-session errors', () => {
  const r = run('background', 'active'); expect(r.setStreaming).not.toHaveBeenCalled(); expect(r.toast).not.toHaveBeenCalled();
});
it('retains explicit current-session failure handling', () => {
  const r = run('active', 'active'); expect(r.setStreaming).toHaveBeenCalledWith(false); expect(r.finish).toHaveBeenCalledWith('active', 'error', expect.any(Object)); expect(r.toast).not.toHaveBeenCalled();
});
