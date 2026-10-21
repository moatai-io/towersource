import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('./UserManagement.tsx', import.meta.url), 'utf8');
const panel = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
const ko = JSON.parse(readFileSync(new URL('../../locales/ko/admin.json', import.meta.url), 'utf8'));
const en = JSON.parse(readFileSync(new URL('../../locales/en/admin.json', import.meta.url), 'utf8'));

describe('separate user management surface', () => {
  it('retains a retryable user list and email state', () => {
    expect(panel).toContain("import { UserManagement } from './UserManagement'");
    expect(source).toContain("if (!usersRes.ok) throw new Error(t('userListLoadFailed'))");
    expect(source).toContain("t('retryUserList')");
    expect(source).toContain("u.account_email || t('accountEmailMissing')");
    expect(source).toContain("t('accountEmailPending')");
  });
  it('provides searchable statuses, reactivation and historical IP', () => {
    expect(source).toContain('listedUsers.map((u, index)');
    expect(source).toContain('const [disabledExpanded, setDisabledExpanded] = useState(false)');
    expect(source).toContain("filter === 'disabled' || Boolean(search.trim()) || disabledExpanded");
    expect(source).toContain("filter === 'disabled'");
    expect(source).toContain('/admin/users/${u.id}/reactivate');
    expect(source).toContain('last_login_ip');
    expect(source).toContain('/admin/users/${userId}/auth-events');
    for (const locale of [ko, en]) expect(locale.loginActivityHint).toBeTruthy();
  });
});
