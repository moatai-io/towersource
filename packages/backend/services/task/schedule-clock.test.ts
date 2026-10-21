import { describe, expect, it } from 'vitest';
import { calculateZonedNextRun, applyScheduleActiveHours } from './schedule-clock.js';

describe('schedule clock', () => {
  it('honors Seoul regardless of the host timezone', () => {
    expect(calculateZonedNextRun({ type: 'daily', hour: 9, minute: 0 }, new Date('2026-09-11T00:30:00Z'), 'Asia/Seoul').toISOString()).toBe('2026-09-12T00:00:00.000Z');
  });
  it('honors half-hour zones', () => {
    expect(calculateZonedNextRun({ type: 'daily', hour: 9, minute: 0 }, new Date('2026-09-11T00:00:00Z'), 'Asia/Kolkata').toISOString()).toBe('2026-09-11T03:30:00.000Z');
  });
  it('skips weekends', () => {
    expect(calculateZonedNextRun({ type: 'weekdays', hour: 9, minute: 0 }, new Date('2026-09-11T01:00:00Z')).toISOString()).toBe('2026-09-14T00:00:00.000Z');
  });
  it('skips nonexistent DST wall times', () => {
    expect(calculateZonedNextRun({ type: 'daily', hour: 2, minute: 30 }, new Date('2026-03-08T05:00:00Z'), 'America/New_York').toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });
  it('does not repeat a daily run in a DST fold', () => {
    expect(calculateZonedNextRun({ type: 'daily', hour: 1, minute: 30 }, new Date('2026-11-01T05:30:00Z'), 'America/New_York').toISOString()).toBe('2026-11-02T06:30:00.000Z');
  });
  it('supports weekly schedules', () => {
    expect(calculateZonedNextRun({ type: 'weekly', day: 1, hour: 9, minute: 0 }, new Date('2026-09-11T00:00:00Z')).toISOString()).toBe('2026-09-14T00:00:00.000Z');
  });
  it('uses elapsed time for intervals', () => {
    expect(calculateZonedNextRun({ type: 'interval', minutes: 30 }, new Date('2026-09-11T00:00:00Z')).toISOString()).toBe('2026-09-11T00:30:00.000Z');
  });
  it('rejects malformed inputs', () => {
    expect(() => calculateZonedNextRun({ type: 'daily' }, new Date(), 'invalid/zone')).toThrow();
    expect(() => calculateZonedNextRun({ type: 'daily', hour: 25 })).toThrow();
    expect(() => calculateZonedNextRun({ type: 'interval', minutes: 0 })).toThrow();
  });
  it('applies active hours in the schedule timezone', () => {
    expect(applyScheduleActiveHours(new Date('2026-09-11T12:00:00Z'), { startHour: 9, endHour: 18 }, 'Asia/Seoul').toISOString()).toBe('2026-09-12T00:00:00.000Z');
  });
});
