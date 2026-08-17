import { describe, expect, it, vi } from 'vitest';

const { connect, query, release } = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../../db/pg.js', () => ({
  getPgPool: () => ({ connect }),
}));

import {
  assertWorkbenchMutationLockHeld,
  withWorkbenchMutationLock,
  workbenchMutationLockKey,
} from './workbench-mutation-lock.js';

function advisoryResult(sql: string) {
  if (sql.includes('pg_advisory_unlock')) return { rows: [{ released: true }] };
  return { rows: [{}] };
}

describe('Workbench mutation lock facade', () => {
  it('uses the existing Project-scoped M key and authenticates only live tokens', async () => {
    query.mockImplementation(async (sql: string) => advisoryResult(sql));
    connect.mockResolvedValue({ query, release });
    let heldToken: Parameters<typeof assertWorkbenchMutationLockHeld>[0] | undefined;

    await withWorkbenchMutationLock('project-1', async held => {
      heldToken = held;
      expect(() => assertWorkbenchMutationLockHeld(held, 'project-1')).not.toThrow();
      expect(() => assertWorkbenchMutationLockHeld(held, 'project-2')).toThrow(/not authentic/);
    });

    expect(workbenchMutationLockKey('project-1')).toBe('runtime-box-workbench-tool-mutation:project-1');
    expect(query).toHaveBeenNthCalledWith(1, 'SELECT pg_advisory_lock(hashtextextended($1, 0))', ['runtime-box-workbench-tool-mutation:project-1']);
    expect(() => assertWorkbenchMutationLockHeld(heldToken!, 'project-1')).toThrow(/not authentic/);
  });
});
