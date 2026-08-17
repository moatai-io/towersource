import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecute } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
}));

vi.mock('../../db/pg-repo.js', () => ({
  execute: mockExecute,
}));

import { archiveExpiredEmptySessions } from './empty-session-cleanup.js';

describe('archiveExpiredEmptySessions', () => {
  beforeEach(() => mockExecute.mockReset());

  it('archives rather than deletes and requires every untouched-session guard', async () => {
    mockExecute.mockResolvedValue({ changes: 3 });

    await expect(archiveExpiredEmptySessions()).resolves.toBe(3);

    expect(mockExecute).toHaveBeenCalledOnce();
    const [sql, params] = mockExecute.mock.calls[0];
    expect(params).toEqual([24]);
    expect(sql.trimStart()).toMatch(/^UPDATE sessions s/);
    expect(sql).not.toMatch(/DELETE FROM sessions/);
    expect(sql).toContain('SET archived = 1');
    expect(sql).toContain("s.created_at < now() - ($1 * interval '1 hour')");
    expect(sql).toContain("s.updated_at < now() - ($1 * interval '1 hour')");
    expect(sql).toContain("(s.label IS NULL OR s.label IN ('temp', '미분류'))");
    expect(sql).toContain("COALESCE(s.kind, 'user') = 'user'");
    expect(sql).toContain('COALESCE(s.auto_named, 1) = 1');
    expect(sql).toContain('COALESCE(s.favorite, 0) = 0');
    expect(sql).toContain('s.parent_session_id IS NULL');
    expect(sql).toContain('s.source_message_id IS NULL');
    expect(sql).toContain('s.claude_session_id IS NULL');
    expect(sql).toContain('s.pi_session_file IS NULL');
  });

  it('preserves sessions with any durable conversation, file, sharing, attachment, child, or worker evidence', async () => {
    mockExecute.mockResolvedValue({ changes: 0 });
    await archiveExpiredEmptySessions();

    const sql = mockExecute.mock.calls[0][0] as string;
    for (const evidenceTable of [
      'messages',
      'sessions child',
      'agent_workers',
      'session_file_edits',
      'session_attachments',
      'session_shares',
      'spawn_callbacks',
    ]) {
      expect(sql).toContain(`FROM ${evidenceTable}`);
    }
  });
});
