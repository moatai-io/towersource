import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve('packages/backend/routes/ws-handler.ts'), 'utf8');

describe('session completion attention broadcast', () => {
  it('broadcasts one engine-neutral terminal event globally and keeps session status activity-only', () => {
    expect(source).toContain('const terminalDecision = decideTurnTerminal({');
    expect(source).toContain('broadcastToAll(toTurnTerminalMessage(terminalDecision));');
    expect(source).not.toContain('completedForAttention');
    expect(source).not.toMatch(/type: 'session_status'[\s\S]{0,180}outcome:/);
  });

  it('uses the same global terminal path for restart recovery', () => {
    const recovery = source.slice(source.indexOf('const recoveryOutcome = towerMsg.outcome'));
    expect(recovery).toContain('const terminalDecision = decideTurnTerminal({');
    expect(recovery).toContain('broadcastToAll(toTurnTerminalMessage(terminalDecision));');
  });
});
