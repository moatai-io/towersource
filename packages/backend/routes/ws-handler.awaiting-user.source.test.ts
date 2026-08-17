import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const WS_HANDLER_PATH = path.resolve(import.meta.dirname, './ws-handler.ts');

describe('ws-handler global AUQ attention contract', () => {
  it('broadcasts content-free awaiting state globally while keeping question content session-scoped', () => {
    const src = fs.readFileSync(WS_HANDLER_PATH, 'utf-8');
    expect(src).toContain("broadcastToAll({ type: 'session_awaiting_user', sessionId, awaiting: true, questionId })");
    expect(src).toContain("broadcastToSession(sessionId, {\n          type: 'ask_user'");
    expect(src).not.toContain("broadcastToAll({ type: 'ask_user'");
  });

  it('clears global awaiting attention on answer and timeout', () => {
    const src = fs.readFileSync(WS_HANDLER_PATH, 'utf-8');
    expect(src).toMatch(/function handleAnswerQuestion[\s\S]*broadcastToAll\(\{ type: 'session_awaiting_user', sessionId, awaiting: false \}\)/);
    expect(src).toMatch(/pendingQuestions\.delete\(questionId\);[\s\S]{0,160}?broadcastToAll\(\{ type: 'session_awaiting_user', sessionId, awaiting: false \}\);\n\s+broadcastToSession\(sessionId, \{ type: 'ask_user_timeout'/);
  });
});
