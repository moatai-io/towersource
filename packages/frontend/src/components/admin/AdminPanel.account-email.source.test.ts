import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./UserManagement.tsx', import.meta.url), 'utf8');

describe('admin account email surface', () => {
  it('offers admin-only reset email in compact and desktop layouts with explicit confirmation', () => {
    expect(source).toContain('/password-reset-email');
    expect(source).toContain('if (!approved) return;');
    expect(source).toContain('sendPasswordResetEmail(compactUser)');
    expect(source).toContain('sendPasswordResetEmail(u)');
    expect(source).toContain("role === 'admin' && <button");
    expect(source).toContain('메일 서비스가 재설정 메일 발송을 접수했습니다.');
  });
  it('keeps email entry inside existing create form and user email cell', () => {
    expect(source).toContain('aria-label="새 사용자 계정 이메일"');
    expect(source).toContain('aria-label={`${u.username} 계정 이메일`}');
    expect(source).toContain("if (!newUser.email.trim())");
    expect(source).toContain('email: email.trim(),');
    expect(source).toContain('passwordConfirm,');
    expect(source).not.toContain('계정 이메일 (선택)');
    for (const path of ['/admin/users/${u.id}/account-email', '/admin/users/${u.id}/account-email/resend', '/admin/users/${u.id}/account-email/pending']) expect(source).toContain(path);
    expect(source).toContain('<EmailInvitationManagement');
    expect(source).toContain("'계정 직접 생성'");
  });

  it('prevents saved operator credentials from filling the new user form', () => {
    expect(source).toContain('name="tower-create-user-id"');
    expect(source).toContain('name="tower-create-user-password"');
    expect(source).toContain('name="tower-create-user-password-confirm"');
    expect(source.match(/autoComplete="new-password"/g)).toHaveLength(3);
    expect(source).toContain('const toggleCreateForm = () => {');
    expect(source).toContain('const closeCreateForm = () => {');
    expect(source.match(/setNewUser\(emptyNewUser\(\)\)/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
