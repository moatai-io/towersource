import { describe, expect, it } from 'vitest';
import { utcUsageWindow, usageSeries } from './usage-period.js';

describe('UTC usage calendar', () => {
  it('includes today and N-1 complete calendar dates, regardless of caller offset', () => {
    expect(utcUsageWindow(3, new Date('2026-09-23T01:30:00+09:00'))).toEqual({
      start: '2026-09-20T00:00:00.000Z', end: '2026-09-23T00:00:00.000Z',
      dates: ['2026-09-20', '2026-09-21', '2026-09-22'],
    });
  });
  it('handles leap-day, one-day and daylight-saving boundaries without local arithmetic', () => {
    expect(utcUsageWindow(2, new Date('2024-03-01T23:59:59Z')).dates).toEqual(['2024-02-29', '2024-03-01']);
    expect(utcUsageWindow(1, new Date('2026-03-08T12:00:00-07:00'))).toEqual({
      start: '2026-03-08T00:00:00.000Z', end: '2026-03-09T00:00:00.000Z', dates: ['2026-03-08'],
    });
    expect(() => utcUsageWindow(0)).toThrow(RangeError);
  });
  it('derives total and active days only from plotted user activity', () => {
    expect(usageSeries(['2026-09-21', '2026-09-22', '2026-09-23'], [
      { date: '2026-09-20', turns: 99 }, { date: '2026-09-21', turns: '2' },
      { date: '2026-09-21', turns: 3 }, { date: '2026-09-23', turns: 7 },
      { date: '2026-09-24', turns: 100 },
    ])).toEqual({ values: [5, 0, 7], total: 12, activeDays: 2 });
  });
});
