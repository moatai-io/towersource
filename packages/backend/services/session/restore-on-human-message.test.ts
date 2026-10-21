import { beforeEach, describe, expect, it, vi } from 'vitest';
const execute = vi.hoisted(() => vi.fn());
vi.mock('../../db/pg-repo.js', () => ({ execute }));
import { restoreOnHumanMessage } from './restore-on-human-message.js';

describe('restoreOnHumanMessage', () => {
  beforeEach(() => execute.mockReset());
  it('restores an archived owner session and clears the archive date without faking activity', async () => {
    execute.mockResolvedValue({ changes: 1 });
    expect(await restoreOnHumanMessage('session', 7)).toBe(true);
    const [sql, params] = execute.mock.calls[0];
    expect(params).toEqual(['session', 7]);
    expect(sql).toContain('archived = 0, archived_at = NULL');
    expect(sql).toContain('user_id = $2 AND archived = 1');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM agent_workers WHERE backing_session_id = sessions.id)');
    expect(sql).not.toContain('updated_at');
  });
  it('does not report restoration when no eligible owner session was updated', async () => {
    execute.mockResolvedValue({ changes: 0 });
    expect(await restoreOnHumanMessage('session', 8)).toBe(false);
  });
});
