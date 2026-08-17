import { describe, expect, it } from 'vitest';
import { decideDueRunAction } from './missed-run-policy.js';

const now = new Date('2026-06-02T09:30:00.000Z');

function auto(overrides: any) {
  return {
    triggerType: 'cron',
    cronConfig: { type: 'daily', hour: 9, minute: 0 },
    nextRunAt: '2026-06-02T09:25:00.000Z',
    ...overrides,
  };
}

describe('decideDueRunAction', () => {
  it('runs cron jobs within grace window', () => {
    expect(decideDueRunAction(auto({}), now).action).toBe('run');
  });

  it('skips cron jobs overdue beyond grace window', () => {
    const result = decideDueRunAction(auto({ nextRunAt: '2026-06-02T09:00:00.000Z' }), now);
    expect(result.action).toBe('skip');
  });

  it('runs one-shot jobs even if overdue', () => {
    expect(decideDueRunAction(auto({ triggerType: 'once', onceAt: '2026-06-02T09:00:00.000Z', nextRunAt: '2026-06-02T09:00:00.000Z' }), now).action).toBe('run');
  });

  it('runs interval jobs once without replaying all missed intervals', () => {
    expect(decideDueRunAction(auto({ cronConfig: { type: 'interval', minutes: 1 }, nextRunAt: '2026-06-02T09:00:00.000Z' }), now).action).toBe('run');
  });
});
