import { describe, expect, it } from 'vitest';
import { serverClockOffset, serverNowMs, syncServerClock } from './server-clock';

describe('server clock offset', () => {
  it('moves elapsed-time calculations into the backend clock domain', () => {
    syncServerClock('2026-07-20T12:00:02.000Z', Date.parse('2026-07-20T12:00:00.000Z'));
    expect(serverClockOffset()).toBe(2_000);
    expect(serverNowMs(Date.parse('2026-07-20T12:00:03.000Z'))).toBe(Date.parse('2026-07-20T12:00:05.000Z'));
  });

  it('does not move the clock backwards for a delayed frame', () => {
    const localNow = Date.parse('2026-07-20T12:10:00.000Z');
    syncServerClock('2026-07-20T12:10:02.000Z', localNow);
    syncServerClock('2026-07-20T12:00:08.000Z', localNow);

    expect(serverClockOffset()).toBe(2_000);
    expect(serverNowMs(localNow) - Date.parse('2026-07-20T12:00:00.000Z')).toBe(602_000);
  });

  it('keeps a newer low-latency offset sample', () => {
    const localNow = Date.parse('2026-07-20T12:20:00.000Z');
    syncServerClock('2026-07-20T12:20:03.000Z', localNow);

    expect(serverClockOffset()).toBe(3_000);
  });

  it('ignores invalid timestamps', () => {
    const before = serverClockOffset();
    syncServerClock('not-a-time');
    expect(serverClockOffset()).toBe(before);
  });
});
