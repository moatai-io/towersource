import { describe, it, expect, vi } from 'vitest';
import { query } from '../../db/pg-repo.js';
import { reconcileAbandonedAgentTurns } from './reconcile-abandoned-turns.js';
vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn() }));

describe('abandoned turn reconciliation query contract', () => {
  it('uses bounded row locks, respects live leases and checks uncertain effects before queuing', async () => {
    vi.mocked(query).mockResolvedValue([{ root_turn_id: 'root' }]);
    expect(await reconcileAbandonedAgentTurns()).toBe(1);
    const sql = String(vi.mocked(query).mock.calls.at(-1)![0]);
    expect(sql).toContain("t.state = 'running'");
    expect(sql).toContain("COALESCE(t.lease_until, t.updated_at + INTERVAL '180 seconds') <= NOW()");
    expect(sql).toContain('FOR UPDATE OF t SKIP LOCKED');
    expect(sql).toContain('LIMIT 20');
    expect(sql).toContain("e.status IN ('running', 'uncertain')");
    expect(sql).toContain('t.waiting_user_started_at IS NULL');
    expect(sql).toContain('m.id <> t.root_turn_id');
    expect(sql).toContain("INTERVAL '24 hours'");
    expect(sql).toContain("THEN 'needs_attention' ELSE 'waiting_retry'");
    expect(sql).not.toContain('owner_boot_id IS DISTINCT FROM');
  });
  it('propagates database failures so the next dispatcher scan can retry', async () => {
    vi.mocked(query).mockRejectedValueOnce(new Error('offline'));
    await expect(reconcileAbandonedAgentTurns()).rejects.toThrow('offline');
  });
});
