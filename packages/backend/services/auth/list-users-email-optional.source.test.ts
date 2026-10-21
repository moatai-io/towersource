import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(import.meta.dirname, 'auth.ts'), 'utf8');
const listUsersSource = source.slice(
  source.indexOf('export async function listUsers()'),
  source.indexOf('/** 본인 프로필 조회', source.indexOf('export async function listUsers()')),
);

describe('admin user list email compatibility', () => {
  it('keeps account email optional and aggregates project access separately', () => {
    expect(listUsersSource).toContain('LEFT JOIN LATERAL (');
    expect(listUsersSource).toContain("WHERE user_id = u.id AND state IN ('verified','pending')");
    expect(listUsersSource).toContain('project_access.projects');
    expect(listUsersSource).not.toContain('GROUP BY u.id, ic.id');
    expect(listUsersSource).toContain("account_email: r.account_email ?? null");
    expect(listUsersSource).toContain("account_email_status: r.account_email_status ?? 'missing'");
  });
});
