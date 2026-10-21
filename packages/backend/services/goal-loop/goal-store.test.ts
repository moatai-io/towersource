import { beforeEach, describe, expect, it, vi } from 'vitest';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ transaction: async (fn: any) => fn({ query }) }));
import { postgresGoalStore, createPostgresGoalStore } from './goal-store';
import { createGoalSession } from './goal-session';
const scope = { userId: 1, projectId: 'p', sessionId: 's', rootTurnId: 'r' };
const input = { requestId: 'start', expectedVersion: 0, command: { action: 'start', goal: 'fix', criteria: [{ id: 'a', description: 'passes' }] } };
beforeEach(() => { query.mockReset(); });
describe('postgres goal storage contract (mock DB)', () => {
  it('denies unauthorized callers before reading goal records', async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(createGoalSession(scope, postgresGoalStore).execute(input)).rejects.toThrow('GOAL_ACCESS_DENIED');
    expect(query.mock.calls.some(([sql]) => sql.includes('SELECT record'))).toBe(false);
  });
  it('locks session before first insert and persists scoped record', async () => {
    query.mockImplementation(async (sql: string) => sql.includes('SELECT s.id') ? { rows: [{ id: 's' }], rowCount: 1 } : { rows: [], rowCount: 0 });
    const guard = { validate: vi.fn(async () => true) };
    const result = await createGoalSession(scope, createPostgresGoalStore(guard)).execute(input);
    expect(guard.validate).toHaveBeenCalledWith(expect.objectContaining({ query }), scope, null, expect.objectContaining({ action: 'start' }));
    expect(result.scope).toEqual(scope);
    const auth = query.mock.calls.find(([sql]) => sql.includes('SELECT s.id'))!;
    expect(auth[0]).toContain('FOR UPDATE OF s');
    expect(auth[1]).toEqual(['s', 1, 'p', 'r']);
    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO goal_sessions'))!;
    expect(JSON.parse(insert[1][4])).toEqual(result);
  });
});

it('default storage refuses writes even after the session ACL passes', async () => {
  query.mockImplementation(async (sql: string) => sql.includes('SELECT s.id') ? { rows: [{ id: 's' }], rowCount: 1 } : { rows: [], rowCount: 0 });
  await expect(createGoalSession(scope, postgresGoalStore).execute(input)).rejects.toThrow('GOAL_TRANSACTION_GUARD_DENIED');
  expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO goal_sessions'))).toBe(false);
});
it('guard failure does not persist proposed changes', async () => {
  query.mockImplementation(async (sql: string) => sql.includes('SELECT s.id') ? { rows: [{ id: 's' }], rowCount: 1 } : { rows: [], rowCount: 0 });
  const store = createPostgresGoalStore({ validate: async () => { throw new Error('fence lost'); } });
  await expect(createGoalSession(scope, store).execute(input)).rejects.toThrow('fence lost');
  expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO goal_sessions'))).toBe(false);
});
it('status needs ACL but does not call mutation guard or write', async () => {
  query.mockImplementation(async (sql: string) => sql.includes('SELECT s.id') ? { rows: [{ id: 's' }], rowCount: 1 } : { rows: [], rowCount: 0 });
  const guard = { validate: vi.fn(async () => false) };
  expect(await createGoalSession(scope, createPostgresGoalStore(guard)).status()).toBeNull();
  expect(guard.validate).not.toHaveBeenCalled();
  expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO goal_sessions'))).toBe(false);
});
