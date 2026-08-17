import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecute } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
}));

vi.mock('../db/pg-repo.js', () => ({
  execute: mockExecute,
}));

import { archiveStaleAgentWorkers } from './agent-worker-cleanup.js';

describe('archiveStaleAgentWorkers', () => {
  beforeEach(() => mockExecute.mockReset());

  it('archives only stale idle/failed workers and preserves all durable data', async () => {
    mockExecute.mockResolvedValue({ changes: 4 });

    await expect(archiveStaleAgentWorkers()).resolves.toBe(4);

    expect(mockExecute).toHaveBeenCalledOnce();
    const [sql, params] = mockExecute.mock.calls[0];
    expect(params).toEqual([30]);
    expect(sql).toContain("aw.status IN ('idle', 'failed')");
    expect(sql).toContain("aw.updated_at < now() - ($1 * interval '1 day')");
    expect(sql).toContain("s.updated_at < now() - ($1 * interval '1 day')");
    expect(sql).toContain("ar.status IN ('queued', 'running')");
    expect(sql).toContain('sc.fired_at IS NULL');
    expect(sql).toContain("SET status = 'archived'");
    expect(sql).toContain('SET archived = 1');
    expect(sql).toContain("'worker_auto_archived'");
    expect(sql).not.toMatch(/DELETE FROM (agent_workers|agent_runs|sessions|messages)/);
  });

  it('records the retention period and session archival in the audit event', async () => {
    mockExecute.mockResolvedValue({ changes: 0 });
    await archiveStaleAgentWorkers();

    const sql = mockExecute.mock.calls[0][0] as string;
    expect(sql).toContain("'reason', 'stale'");
    expect(sql).toContain("'retentionDays', $1");
    expect(sql).toContain("'sessionArchived', aw.backing_session_id IS NOT NULL");
  });
});
