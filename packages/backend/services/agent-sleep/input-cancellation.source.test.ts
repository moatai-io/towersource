import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source contract complements abort/timer behavior tests without launching an SDK.
describe('sleep input and stop wiring', () => {
  const pi = readFileSync('packages/backend/engines/pi-engine.ts', 'utf8');
  const ws = readFileSync('packages/backend/routes/ws-handler.ts', 'utf8');
  it('releases sleep only after Pi accepts steering', () => {
    const steer = pi.slice(pi.indexOf('await entry.session.steer(message);'), pi.indexOf('async cancelSteer('));
    expect(steer).toContain('await invalidateWaitAlarm(sessionId');
    expect(steer).toContain('cancelSessionSleep(sessionId)');
  });
  it('releases sleep after accepting the queued human message', () => {
    expect(ws).toMatch(/enqueuePendingUserMessage\(sessionId, \{ client, data: dataWithId \}\);\s*\/\/[^\n]*\n\s*cancelSessionSleep\(sessionId\);/);
  });
  it('does not treat an intentional wait as a websocket hang', () => {
    expect(ws.match(/if \(isSessionSleeping\(sessionId\)\) \{ resetHangTimer\(\); return; \}/g)).toHaveLength(2);
  });
  it('cancels a timer before Pi safe stop or abort waits for tool completion', () => {
    const safeStop = pi.slice(pi.indexOf('async requestStopAtBoundary('), pi.indexOf('async steer('));
    expect(safeStop).toMatch(/entry\.safeStopRequested = true;[\s\S]*cancelSessionSleep\(sessionId\);/);
    const abort = pi.slice(pi.indexOf('abort(sessionId: string): void {'));
    expect(abort.indexOf("invalidateWaitAlarm(sessionId, 'cancelled')")).toBeLessThan(abort.indexOf('entry.session.abort()'));
    expect(abort.indexOf('cancelSessionSleep(sessionId)')).toBeLessThan(abort.indexOf('entry.session.abort()'));
  });
});
