import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ query: vi.fn(), committed: 0, rolledBack: 0 }));
vi.mock('../../db/pg-repo.js', () => ({ transaction: async (fn: any) => {
  try { const result = await fn({ query: m.query }); m.committed++; return result; }
  catch (error) { m.rolledBack++; throw error; }
} }));
import { commitVoiceFastDirect } from './voice-fast-store.js';
const request = () => ({ voiceSessionId: 'v', sessionId: 's', userId: 7, turnId: 'turn', revision: 1, transcript: '안녕', answer: '안녕하세요', username: 'test', model: 'test/fast', signal: new AbortController().signal });
beforeEach(() => { m.committed = 0; m.rolledBack = 0; m.query.mockReset(); m.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT id FROM sessions') ? [{ id: 's' }] : [] })); });
describe('transactional direct commit (fake DB, no provider)', () => {
  it('writes exactly one user, one assistant and linked terminal without changing Session model', async () => {
    const result = await commitVoiceFastDirect(request());
    const calls = m.query.mock.calls;
    expect(calls.filter(([sql]) => sql.startsWith('INSERT INTO messages'))).toHaveLength(2);
    expect(calls.find(([sql]) => sql.startsWith('INSERT INTO agent_turns'))?.[1]).toEqual(['turn', 's', result.assistantMessageId]);
    expect(calls.map(([sql]) => sql).join('')).not.toMatch(/ON CONFLICT|model_used|effort/);
    expect(m.committed).toBe(1);
  });
  it('rolls back both messages on terminal failure rather than making an incomplete direct reply', async () => {
    const base = m.query.getMockImplementation()!;
    m.query.mockImplementation(async (sql: string, args: unknown[]) => { if (sql.startsWith('INSERT INTO agent_turns')) throw new Error('fixture failure'); return base(sql, args); });
    await expect(commitVoiceFastDirect(request())).rejects.toThrow(); expect(m.rolledBack).toBe(1); expect(m.committed).toBe(0);
  });
  it('checks cancellation before transaction completion', async () => {
    const abort = new AbortController(); const base = m.query.getMockImplementation()!;
    m.query.mockImplementation(async (sql: string, args: unknown[]) => { if (sql.startsWith('UPDATE sessions')) abort.abort(); return base(sql, args); });
    await expect(commitVoiceFastDirect({ ...request(), signal: abort.signal })).rejects.toThrow(); expect(m.rolledBack).toBe(1);
  });
});
