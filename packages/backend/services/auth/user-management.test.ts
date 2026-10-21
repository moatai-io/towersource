import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canManageUserRole } from '../authority/user-management-policy.js';
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), invalidate: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ transaction: mocks.transaction }));
vi.mock('./auth.js', () => ({ invalidateAuthCache: mocks.invalidate }));
import { listUserAuthEvents, reactivateUser } from './user-management.js';

type Target = { role: string; disabled: number; approval_status: string };
function fixture(target: Target | null = { role: 'member', disabled: 1, approval_status: 'active' }) {
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const client = { query: vi.fn(async (sql: string, args: unknown[] = []) => {
    statements.push({ sql, args });
    if (sql.includes('FROM users WHERE id = $1 FOR')) return { rows: target ? [target] : [] };
    if (sql.startsWith('UPDATE users')) return { rows: target?.disabled === 1 && target.approval_status === 'active' ? [{ id: args[0] }] : [] };
    if (sql.includes('FROM auth_login_events')) return { rows: [{ id: 10, event_type: 'login_success', ip_address: null, created_at: 'synthetic' }] };
    if (sql.includes('INSERT INTO account_security_events')) return { rows: [{ id: 1 }] };
    throw new Error('Unexpected SQL in synthetic fixture');
  }) };
  mocks.transaction.mockImplementation(async callback => callback(client));
  return { statements, client };
}
beforeEach(() => { vi.clearAllMocks(); });

describe('transactional user reactivation', () => {
  it('locks the target, checks role, updates epoch and audits actor/target/success in one transaction', async () => {
    const { statements } = fixture();
    expect(await reactivateUser({ userId: 4, actorUserId: 2, actorRole: 'operator' })).toBe('reactivated');
    expect(statements.map(s => s.sql)).toEqual([
      expect.stringContaining('FOR UPDATE'), expect.stringContaining('auth_epoch = auth_epoch + 1'),
      expect.stringContaining('INSERT INTO account_security_events'),
    ]);
    expect(statements[2].args.slice(0, 3)).toEqual([2, 4, 'success']);
    expect(JSON.parse(String(statements[2].args[3]))).toEqual({ outcome: 'reactivated' });
    expect(mocks.invalidate).toHaveBeenCalledWith(4);
  });
  it.each([
    [{ role: 'operator', disabled: 1, approval_status: 'active' }, 'forbidden', 'blocked'],
    [{ role: 'admin', disabled: 1, approval_status: 'active' }, 'forbidden', 'blocked'],
    [{ role: 'member', disabled: 1, approval_status: 'pending' }, 'ineligible', 'failure'],
    [{ role: 'member', disabled: 0, approval_status: 'active' }, 'ineligible', 'failure'],
  ] as const)('records %s as %s without restoring', async (row, expected, auditResult) => {
    const { statements } = fixture({ ...row });
    expect(await reactivateUser({ userId: 4, actorUserId: 2, actorRole: 'operator' })).toBe(expected);
    expect(statements.some(s => s.sql.startsWith('UPDATE users'))).toBe(false);
    expect(statements.at(-1)?.args.slice(0, 3)).toEqual([2, 4, auditResult]);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  it('audits a missing target without violating the target FK', async () => {
    const { statements } = fixture(null);
    expect(await reactivateUser({ userId: 4, actorUserId: 2, actorRole: 'operator' })).toBe('not_found');
    expect(statements.at(-1)?.args.slice(0, 3)).toEqual([2, null, 'failure']);
    expect(JSON.parse(String(statements.at(-1)?.args[3]))).toEqual({ outcome: 'not_found', requestedUserId: 4 });
  });
  it('does not invalidate auth state or report success when the audit insert fails', async () => {
    const { client } = fixture();
    const original = client.query.getMockImplementation()!;
    client.query.mockImplementation((sql: string, args: unknown[]) => sql.includes('INSERT INTO account_security_events')
      ? Promise.reject(new Error('audit unavailable')) : original(sql, args));
    await expect(reactivateUser({ userId: 4, actorUserId: 2, actorRole: 'admin' })).rejects.toThrow('audit unavailable');
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  it('rechecks the role under lock, rather than trusting an earlier operator preflight', async () => {
    const row: Target = { role: 'operator', disabled: 1, approval_status: 'active' };
    expect(canManageUserRole('operator', 'member')).toBe(true); // earlier unlocked observation
    const { statements } = fixture(row); // role changed before the lock
    expect(await reactivateUser({ userId: 4, actorUserId: 2, actorRole: 'operator' })).toBe('forbidden');
    expect(statements.some(s => s.sql.startsWith('UPDATE users'))).toBe(false);
  });
});

describe('bounded per-user events', () => {
  it('keeps target role locked through history read and omits user agent', async () => {
    const { statements } = fixture();
    expect(await listUserAuthEvents({ userId: 4, actorRole: 'operator', before: 100 })).toHaveLength(1);
    expect(statements[0].sql).toContain('FOR SHARE');
    expect(statements[1].sql).toContain('WHERE user_id = $1');
    expect(statements[1].sql).toContain('ORDER BY id DESC LIMIT 20');
    expect(statements[1].sql).not.toContain('user_agent');
    expect(statements[1].args).toEqual([4, 100]);
  });
  it('does not expose history when an earlier ordinary role is promoted before the lock', async () => {
    const { statements } = fixture({ role: 'admin', disabled: 0, approval_status: 'active' });
    expect(await listUserAuthEvents({ userId: 4, actorRole: 'operator' })).toBe('forbidden');
    expect(statements.some(s => s.sql.includes('FROM auth_login_events'))).toBe(false);
  });
});
