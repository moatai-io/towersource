import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const WS_HANDLER_PATH = path.resolve(import.meta.dirname, './ws-handler.ts');
const PENDING_PATH = path.resolve(import.meta.dirname, '../services/session/pending-questions.ts');

describe('ws-handler recipient-scoped AUQ attention contract', () => {
  it('delivers both attention and question payload only to the execution recipient', () => {
    const src = fs.readFileSync(PENDING_PATH, 'utf-8');
    expect(src).toContain('opts.recipientUserId ?? (await queryOne');
    expect(src).toContain('broadcasts?.toUser(recipientUserId, { ...data, recipientUserId })');
    expect(src).toContain("deliver({ type: 'session_awaiting_user', sessionId, awaiting: true, questionId })");
    expect(src).toContain("type: 'ask_user',");
    expect(src).not.toMatch(/broadcasts\?\.toAll\(\{\s*type: '(?:ask_user|session_awaiting_user)'/);
  });

  it('clears recipient attention on answer and timeout', () => {
    const src = fs.readFileSync(WS_HANDLER_PATH, 'utf-8');
    expect(src).toMatch(/function handleAnswerQuestion[\s\S]*broadcastToUser\(client\.userId!, \{ type: 'session_awaiting_user', sessionId, awaiting: false, questionId: data\.questionId \}\)/);
    const pending = fs.readFileSync(PENDING_PATH, 'utf-8');
    expect(pending).toMatch(/pendingQuestions\.delete\(questionId\);[\s\S]{0,200}?deliver\(\{ type: 'session_awaiting_user', sessionId, awaiting: false, questionId \}\);\n\s+deliver\(\{ type: 'ask_user_timeout'/);
  });
});
