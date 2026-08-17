import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, 'App.tsx'), 'utf8');

describe('Conversation branch replay prompt handling', () => {
  it('waits for the child session to become active before sending the replay prompt', () => {
    expect(source).toContain("window.addEventListener('tower-replay-branch-prompt', handler)");
    expect(source).toContain('const replayKey = `${sessionId}:${prompt}`');
    expect(source).toContain('replayBranchPromptKeysRef.current.has(replayKey)');
    expect(source).toContain('attempts >= 40');
    expect(source).toMatch(/useSessionStore\.getState\(\)\.activeSessionId === sessionId[\s\S]*useChatStore\.getState\(\)\.sessionId === sessionId/);
    expect(source).toContain('sendMessage(prompt, { cwd: detail.cwd, suppressUserEcho: false })');
  });
});
