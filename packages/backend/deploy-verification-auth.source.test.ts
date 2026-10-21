import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('scripts/deploy-verify.mjs', 'utf8');
describe('deployment verification authentication contract', () => {
  it('uses an active representative account with its current auth epoch', () => {
    expect(source).toContain('SELECT id, username, role, auth_epoch');
    expect(source).toContain("COALESCE(disabled, 0) = 0");
    expect(source).toContain("COALESCE(approval_status, 'active') = 'active'");
    expect(source).toContain('authEpoch: Number(user.auth_epoch ?? 0)');
  });
});
