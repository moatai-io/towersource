import { beforeEach, describe, expect, it, vi } from 'vitest';
const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ queryOne: lookup }));
import { emailTargetAccess } from './email-management-access.js';
import { readFileSync } from 'node:fs';
beforeEach(() => { lookup.mockReset(); });
describe('email operator delegation', () => {
  for (const kind of ['user', 'invitation'] as const) {
    for (const role of ['member', 'viewer', 'guest', 'operator', 'admin']) {
      it(`${kind}: operator can manage only ordinary targets (${role})`, async () => {
        lookup.mockResolvedValue({ role });
        const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }; const next = vi.fn();
        await emailTargetAccess(kind)({ user: { role: 'operator' }, params: { id: '7' } } as any, res as any, next);
        expect(next).toHaveBeenCalledTimes(['member','viewer','guest'].includes(role) ? 1 : 0);
        if (['operator','admin'].includes(role)) expect(res.status).toHaveBeenCalledWith(403);
      });
    }
  }
  it('fails closed on database failure', async () => {
    lookup.mockRejectedValue(new Error('unavailable'));
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }; const next = vi.fn();
    await emailTargetAccess('user')({ user: { role: 'operator' }, params: { id: '7' } } as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(503); expect(next).not.toHaveBeenCalled();
  });
  it('guards each mutation route and invitation role assignment', () => {
    const source = readFileSync(new URL('../../routes/api.ts', import.meta.url), 'utf8');
    for (const path of ['/admin/users/:id/account-email', '/admin/users/:id/account-email/resend','/admin/users/:id/account-email/pending']) expect(source).toContain(`'${path}', operatorOrAboveMiddleware, emailTargetAccess('user')`);
    for (const action of ['resend','cancel']) expect(source).toContain(`'/admin/account-email-invitations/:id/${action}', operatorOrAboveMiddleware, emailTargetAccess('invitation')`);
    expect(source).toContain("canManageUserRole(currentUser.role, undefined, req.body.role || 'member')");
  });
});
