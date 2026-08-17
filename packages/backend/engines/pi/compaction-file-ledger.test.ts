import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();

vi.mock('../../db/pg-repo.js', () => ({ query }));

const { appendTowerFileLedgerCheckpoint } = await import('./compaction-file-ledger.js');

describe('appendTowerFileLedgerCheckpoint', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('appends a hidden context checkpoint with the DB-backed session file ledger', async () => {
    query
      .mockResolvedValueOnce([{ count: '2' }])
      .mockResolvedValueOnce([
        { file_path: '/home/tower/tower/packages/backend/a.ts', tool_name: 'Edit', touched_at: '2026-08-13T00:00:00Z' },
        { file_path: '/home/tower/tower/workspace/decisions/d.md', tool_name: 'Write', touched_at: '2026-08-13T00:01:00Z' },
      ]);
    const appendCustomMessageEntry = vi.fn(() => 'custom-1');

    const result = await appendTowerFileLedgerCheckpoint({
      sessionId: 'session-1',
      session: { appendCustomMessageEntry },
      reason: 'unit-test',
    });

    expect(result).toMatchObject({ appended: true, entryId: 'custom-1', fileCount: 2, omittedCount: 0 });
    expect(appendCustomMessageEntry).toHaveBeenCalledTimes(1);
    const [customType, content, display, details] = appendCustomMessageEntry.mock.calls[0];
    expect(customType).toBe('tower-file-ledger');
    expect(display).toBe(false);
    expect(content).toContain('## Tower Durable File Ledger');
    expect(content).toContain('/home/tower/tower/packages/backend/a.ts');
    expect(content).toContain('/home/tower/tower/workspace/decisions/d.md');
    expect(content).toContain('It may include files edited many turns before the latest compaction.');
    expect(details).toMatchObject({ source: 'session_file_edits', fileCount: 2, omittedCount: 0, reason: 'unit-test' });
  });

  it('skips cleanly when the session has no recorded file ledger rows', async () => {
    query.mockResolvedValueOnce([{ count: '0' }]);
    const appendCustomMessageEntry = vi.fn(() => 'custom-1');

    const result = await appendTowerFileLedgerCheckpoint({
      sessionId: 'session-1',
      session: { appendCustomMessageEntry },
      reason: 'unit-test',
    });

    expect(result).toMatchObject({ appended: false, fileCount: 0, omittedCount: 0, reason: 'no file ledger rows' });
    expect(appendCustomMessageEntry).not.toHaveBeenCalled();
  });
});
