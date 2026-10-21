import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('auto-resume shared question registration', () => {
  it('uses the shared question factory with background timeout policy', () => {
    const source = readFileSync(new URL('./ws-handler.ts', import.meta.url), 'utf8');
    const block = source.slice(source.indexOf('// Engine callbacks — same as handleChat'));
    expect(block).toMatch(/askUser: createSessionAskUser\(\{\s*sessionId,\s*recipientUserId: userId,\s*userMessageId,\s*logTag: 'auto-resume',\s*timeoutMessage: backgroundTimeoutMessage,\s*\}\)/);
    expect(block).not.toContain('pendingQuestions.');
    expect(block).not.toContain('sanitizeAskUserQuestions(');
    expect(block).not.toContain('ASK_USER_TIMEOUT');
  });
});
