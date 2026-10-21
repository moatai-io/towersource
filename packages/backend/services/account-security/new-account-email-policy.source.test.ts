import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const routes = readFileSync(new URL('../../routes/api.ts', import.meta.url), 'utf8');

describe('new account email boundary', () => {
  it('keeps first-admin setup and existing login while closing invite-code signup', () => {
    expect(routes).toContain("router.post('/auth/setup'");
    expect(routes).toContain("router.post('/auth/login'");
    const signup = routes.split("router.post('/auth/signup'")[1].split("router.get('/auth/account-invitation")[0];
    expect(signup).toContain('res.status(410)');
    expect(signup).not.toContain('requestSignup(');
  });

  it('rejects missing email in administrator creation without a legacy fallback', () => {
    const create = routes.split("router.post('/admin/users'")[1].split("router.patch('/admin/users/:id'")[0];
    expect(create).toContain("typeof email !== 'string' || !email.trim()");
    expect(create).toContain('createAdminManagedAccount(');
    expect(create).not.toContain('createUser(');
  });
});
