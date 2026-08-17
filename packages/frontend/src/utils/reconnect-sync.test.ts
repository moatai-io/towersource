import { describe, it, expect } from 'vitest';
import { buildReconnectSyncPlan } from './reconnect-sync';

describe('buildReconnectSyncPlan', () => {
  it('reconnects the active session without retired room actions', () => {
    const plan = buildReconnectSyncPlan({
      sessionId: 's1',
      claudeSessionId: 'c1',
    });

    expect(plan.wsMessages).toEqual([
      { type: 'reconnect', sessionId: 's1', claudeSessionId: 'c1' },
      { type: 'task_list' },
    ]);
    expect(plan.refetchSessions).toBe(true);
    expect(plan.refetchActiveSessionMessages).toBe('s1');
    expect(JSON.stringify(plan)).not.toContain('room_');
  });

  it('keeps task refresh when there is no active session', () => {
    const plan = buildReconnectSyncPlan({
      sessionId: null,
      claudeSessionId: null,
    });

    expect(plan.wsMessages).toEqual([{ type: 'task_list' }]);
    expect(plan.refetchSessions).toBe(true);
    expect(plan.refetchActiveSessionMessages).toBeNull();
  });
});
