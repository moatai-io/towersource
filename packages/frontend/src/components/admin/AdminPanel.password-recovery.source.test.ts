import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./UserManagement.tsx', import.meta.url), 'utf8');
const backend = readFileSync(new URL('../../../../backend/services/auth/auth.ts', import.meta.url), 'utf8');

describe('user management credential safety', () => {
  it('does not render, copy, or fetch stored password material', () => {
    expect(source).not.toMatch(/password_plain|PasswordCell|revealPassword|setDraft\(password\)/);
    expect(backend.slice(backend.indexOf('export async function listUsers()'), backend.indexOf('/** 본인 프로필 조회'))).not.toMatch(/password_hash|password_plain|decryptPassword/);
  });
  it('keeps explicit admin reset with masked inputs', () => {
    expect(source).toContain('disabled={role !== \'admin\' || u.disabled}');
    expect(source).toContain('type="password"');
    expect(source).toContain('/admin/users/${userId}/password');
  });
});
