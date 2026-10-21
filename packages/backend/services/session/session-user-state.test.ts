import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
const queryOne = vi.fn();
const txExecute = vi.fn();
const txQueryOne = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({
  execute,
  queryOne,
  transaction: async (fn: (client: object) => Promise<unknown>) => fn({}),
  withClient: () => ({ execute: txExecute, queryOne: txQueryOne }),
}));

const {
  getSessionUserState,
  markAiResponseRead,
  recordCompletedAiTurn,
  setSessionSubscription,
  subscribeSessionParticipant,
  subscribeSessionParticipantByUsername,
} = await import('./session-user-state.js');

describe('session user state', () => {
  beforeEach(() => vi.clearAllMocks());

  it('computes unread only for subscribed users past both cursors', async () => {
    queryOne.mockResolvedValue({
      user_id: 7,
      session_id: 's1',
      participated_at: null,
      subscription_state: 'subscribed',
      subscribed_from_sequence: '2',
      last_read_ai_sequence: '3',
      last_final_ai_sequence: '4',
      updated_at: new Date('2026-09-18T00:00:00Z'),
    });

    await expect(getSessionUserState(7, 's1')).resolves.toMatchObject({
      unreadAiResponse: true,
      lastFinalAiSequence: 4,
      lastReadAiSequence: 3,
    });
  });

  it('re-subscribes a participant from the current server sequence', async () => {
    execute.mockResolvedValue({ changes: 1 });
    await subscribeSessionParticipant(7, 's1');
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain("subscription_state = 'subscribed'");
    expect(sql).toContain('s.last_final_ai_sequence');
    expect(sql).toContain("WHEN session_user_states.subscription_state = 'muted'");
    expect(params).toEqual([7, 's1']);
  });

  it('resolves only a persisted active username for automatic participation', async () => {
    queryOne.mockResolvedValue({ id: 8 });
    execute.mockResolvedValue({ changes: 1 });
    await subscribeSessionParticipantByUsername('person@example.com', 's1');
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('COALESCE(disabled, 0) = 0'), ['person@example.com']);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('manual subscription starts at the current sequence without changing participation', async () => {
    execute.mockResolvedValue({ changes: 1 });
    await setSessionSubscription(7, 's1', true);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).not.toContain('participated_at');
    expect(sql).toContain("WHEN EXCLUDED.subscription_state = 'subscribed'");
    expect(params).toEqual([7, 's1', 'subscribed']);
  });

  it('records one completion sequence under a locked Session row', async () => {
    txQueryOne
      .mockResolvedValueOnce({ last_final_ai_sequence: '4' })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ ai_sequence: '5' });
    txExecute.mockResolvedValue({ changes: 1 });

    await expect(recordCompletedAiTurn({
      sessionId: 's1', rootTurnId: 'r1', assistantMessageId: 'a1',
    })).resolves.toBe(5);
    expect(txQueryOne.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(txQueryOne.mock.calls[2][0]).toContain("m.role = 'assistant'");
    expect(txExecute).toHaveBeenCalledWith(
      expect.stringContaining('last_final_ai_sequence = $2'),
      ['s1', 5],
    );
  });

  it('returns an existing completion sequence without incrementing again', async () => {
    txQueryOne
      .mockResolvedValueOnce({ last_final_ai_sequence: '5' })
      .mockResolvedValueOnce({ ai_sequence: '5' });

    await expect(recordCompletedAiTurn({
      sessionId: 's1', rootTurnId: 'r1', assistantMessageId: 'a1',
    })).resolves.toBe(5);
    expect(txExecute).not.toHaveBeenCalled();
  });

  it('clamps a read cursor to the server sequence and never decreases it', async () => {
    execute.mockResolvedValue({ changes: 1 });
    await markAiResponseRead(7, 's1', 999);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain('GREATEST');
    expect(sql).toContain('LEAST($3::bigint, s.last_final_ai_sequence)');
    expect(params).toEqual([7, 's1', 999]);
  });
});
