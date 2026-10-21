import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const messageStore = fs.readFileSync(path.resolve('packages/backend/services/message-store.ts'), 'utf8');
const wsHandler = fs.readFileSync(path.resolve('packages/backend/routes/ws-handler.ts'), 'utf8');

describe('Session AI-response unread write wiring', () => {
  it('re-subscribes only persisted user rows carrying a Tower username', () => {
    expect(messageStore).toContain("if (msg.role === 'user' && msg.username)");
    expect(messageStore).toContain('subscribeSessionParticipantByUsername(msg.username, sessionId)');
  });

  it('records completed terminal decisions before global delivery', () => {
    const main = wsHandler.slice(wsHandler.indexOf("if (towerMsg.type === 'engine_done')"));
    const record = main.indexOf('await recordCompletedAiTurn({');
    const broadcast = main.indexOf('broadcastToAll(toTurnTerminalMessage(terminalDecision));');
    expect(record).toBeGreaterThan(-1);
    expect(broadcast).toBeGreaterThan(record);
  });

  it('uses the same completion ledger for restart recovery', () => {
    const recovery = wsHandler.slice(wsHandler.indexOf('const recoveryOutcome = towerMsg.outcome'));
    expect(recovery).toContain('await recordCompletedAiTurn({');
    expect(recovery).toContain('rootTurnId: terminalDecision.rootTurnId');
  });
});
