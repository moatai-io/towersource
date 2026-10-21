import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const execution = readFileSync(new URL('./useMessageExecution.ts', import.meta.url), 'utf8');

describe('message execution ownership', () => {
  it('keeps App on hook wiring', () => {
    expect(app).toContain('const { handleSendMessage } = useMessageExecution({');
    expect(app).not.toContain("window.addEventListener('tower-replay-branch-prompt'");
    expect(app).not.toContain("window.addEventListener('tower-start-prompt-session'");
    expect(app).not.toContain("window.addEventListener('tower-run-agent-command'");
  });

  it('creates one session before first send and activates its chat tab', () => {
    expect(execution).toContain('if (creatingSession.current) return;');
    expect(execution).toContain('const session = await createSessionInDb();');
    expect(execution).toContain('useChatStore.getState().setSessionId(session.id)');
    expect(execution).toContain('useFileStore.getState().openChatTab(session.id)');
  });

  it('replays branch prompts only in the selected child session with bounded retries', () => {
    expect(execution).toContain('attempts >= 40');
    expect(execution).toContain('activeSessionId === sessionId');
    expect(execution).toContain('useChatStore.getState().sessionId === sessionId');
    expect(execution).toContain('suppressUserEcho: false');
  });

  it('initializes prompt sessions before delayed execution', () => {
    const sessionId = execution.indexOf('setActiveSessionId(session.id)');
    const clear = execution.indexOf('clearMessages()', sessionId);
    const runtime = execution.indexOf('setActiveRuntimeSession(session.id)', clear);
    const send = execution.indexOf('window.setTimeout(() => sendMessage', runtime);
    expect(sessionId).toBeGreaterThan(-1);
    expect(sessionId).toBeLessThan(clear);
    expect(clear).toBeLessThan(runtime);
    expect(runtime).toBeLessThan(send);
  });
});
