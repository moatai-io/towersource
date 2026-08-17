import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ execute: vi.fn(), query: vi.fn(), queryOne: vi.fn(), transaction: vi.fn(), withClient: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => db);

import {
  assertWorkbenchWorkerIdentityActive,
  recordWorkbenchWorkerIdentity,
  revokeWorkbenchWorkerIdentity,
} from './workbench-worker-identity-repository.js';

const identity = { workerId: 'worker-a', projectIds: ['p1'], capabilities: ['job'], jti: 'jti-a', expiresAt: '2099-01-01T00:00:00.000Z' };

beforeEach(() => { vi.clearAllMocks(); });

describe('Workbench Worker identity repository', () => {
  it('records metadata without accepting or persisting raw token material', async () => {
    db.queryOne.mockResolvedValue({ jti: 'jti-a' });
    await recordWorkbenchWorkerIdentity({ identity, issuedByUserId: 7, reason: 'bootstrap' });
    const [sql, params] = db.queryOne.mock.calls[0];
    expect(sql).toContain('runtime_box_workbench_worker_identities');
    expect(params).toEqual(['jti-a', 'worker-a', ['p1'], ['job'], 7, identity.expiresAt, 'bootstrap']);
    expect(JSON.stringify({ sql, params })).not.toContain('token');
  });

  it('fails closed for unknown, revoked, expired, or Worker-mismatched identity rows', async () => {
    db.queryOne.mockResolvedValueOnce({ active: true });
    await expect(assertWorkbenchWorkerIdentityActive(identity)).resolves.toBeUndefined();
    for (const row of [undefined, { active: false }]) {
      db.queryOne.mockResolvedValueOnce(row);
      await expect(assertWorkbenchWorkerIdentityActive(identity)).rejects.toThrow('WORKER_IDENTITY_INACTIVE');
    }
  });

  it('revokes by jti without needing raw JWT values', async () => {
    db.execute.mockResolvedValue({ changes: 1 });
    await expect(revokeWorkbenchWorkerIdentity({ jti: 'jti-a', reason: 'rotate' })).resolves.toBe(true);
    expect(db.execute.mock.calls[0][1]).toEqual(['jti-a', 'rotate']);
  });
});
