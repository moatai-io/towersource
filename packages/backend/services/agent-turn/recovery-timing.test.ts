import { expect, it, vi } from 'vitest';
vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));
import { queryOne } from '../../db/pg-repo.js';
import { getActiveAgentTurnTiming } from './turn-supervisor.js';
it('projects already persisted superseded rows at the reconnect snapshot boundary', async () => {
  vi.mocked(queryOne).mockResolvedValueOnce({ root_turn_id: 'old', state: 'needs_attention', accepted_at: '2026-01-01', execution_started_at: null, waiting_user_started_at: null, waiting_user_ms: 0, terminal_at: '2026-01-02', last_error: 'internal diagnostic', last_failure_class: 'restart_recovery_superseded' });
  expect(await getActiveAgentTurnTiming('session')).toMatchObject({ rootTurnId: 'old', state: 'needs_attention', lastError: 'internal diagnostic', requiresAttention: false, recoveryDisposition: 'superseded' });
  expect(vi.mocked(queryOne).mock.calls[0][0]).toContain('last_failure_class');
});
