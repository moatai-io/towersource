import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './ws-handler.ts'), 'utf8');

describe('authoritative turn timing websocket contract', () => {
  it('keeps acceptedAt in the active run registry and reconnect snapshots', () => {
    expect(source).toContain('const activeTurnTimings = new Map<string, ActiveTurnTiming>()');
    expect(source).toContain('const turnTiming: ActiveTurnTiming = { rootTurnId: userMsgId, acceptedAt }');
    expect(source).toContain('streamingSessionRuns: runningSessionIds.map');
    expect(source).toContain('turnTiming: snapshot?.turnTiming || null');
    expect(source).toContain('getActiveAgentTurnTiming(sessionId)');
  });

  it('includes authoritative timing in status and status-check frames', () => {
    expect(source).toContain("status: 'streaming',\n    turnTiming,");
    expect(source).toContain('const turnTiming = activeTurnTimings.get(checkSid)');
    expect(source).toContain('|| remoteStreamingSessions.get(checkSid)?.timing');
    expect(source).toContain('|| durableTiming');
    expect(source).toContain("status: actualStatus,\n          turnTiming,");
    expect(source).toContain('activeTurnTimings.delete(sessionId)');
    expect(source).toContain('setAgentTurnWaitingUser(userMsgId, true)');
    expect(source).toContain('setAgentTurnWaitingUser(activeRootTurnId, false)');
    expect(source).toContain('acceptedAt: turnTiming.acceptedAt');
  });
});
