import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(
  path.join(process.cwd(), 'packages/backend/db/migrations/191_remove_customer_manager_role.sql'),
  'utf8',
);

describe('customer_manager role removal migration', () => {
  it('promotes existing users and invite defaults to operator', () => {
    expect(sql).toContain("UPDATE users");
    expect(sql).toContain("SET role = 'operator'");
    expect(sql).toContain("WHERE role = 'customer_manager'");
    expect(sql).toContain("UPDATE signup_invite_codes");
    expect(sql).toContain("SET default_role = 'operator'");
    expect(sql).toContain("WHERE default_role = 'customer_manager'");
  });

  it('retains legacy mappings temporarily for rollback and audit', () => {
    expect(sql).toContain('COMMENT ON TABLE user_customer_vms');
    expect(sql).not.toContain('DROP TABLE user_customer_vms');
  });
});
