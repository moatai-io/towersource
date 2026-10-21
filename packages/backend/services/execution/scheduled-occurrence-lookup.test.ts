import { describe, expect, it, vi } from 'vitest';
vi.mock('../../db/pg-repo.js', () => ({ queryOne: vi.fn() }));
import { hasScheduledAutomationExecution } from './scheduled-occurrence-lookup.js';

describe('read-only scheduled occurrence lookup', () => {
  it('normalizes the same dueAt identity and performs only a SELECT', async () => {
    const query = vi.fn().mockResolvedValue({ source_kind: 'automation', source_id: 'test-auto' });
    expect(await hasScheduledAutomationExecution('test-auto', '2026-09-22T18:00:00+09:00', query)).toBe(true);
    expect(query).toHaveBeenCalledExactlyOnceWith(
      'SELECT source_kind, source_id FROM executions WHERE idempotency_key = $1',
      ['automation:test-auto:schedule:2026-09-22T09:00:00.000Z'],
    );
  });
  it('returns absence only when the query succeeds without a row', async () => {
    expect(await hasScheduledAutomationExecution('a', '2026-09-22T09:00:00Z', vi.fn().mockResolvedValue(undefined))).toBe(false);
    await expect(hasScheduledAutomationExecution('a', '2026-09-22T09:00:00Z', vi.fn().mockRejectedValue(new Error('DB unavailable')))).rejects.toThrow('DB unavailable');
  });
  it.each([{ source_kind: 'manual', source_id: 'a' }, { source_kind: 'automation', source_id: 'other' }])('rejects conflicting identity %j', async row => {
    await expect(hasScheduledAutomationExecution('a', '2026-09-22T09:00:00Z', vi.fn().mockResolvedValue(row))).rejects.toThrow('identity conflicts');
  });
});
