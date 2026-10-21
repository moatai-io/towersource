import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './credential-vault-api.ts'), 'utf8');

describe('Agent creation team Google Connection catalog', () => {
  it('is available to authenticated members without exposing secret fields', () => {
    expect(source).toContain("router.get('/connections/team-google'");
    expect(source).toContain('const auth = assertAuthenticated(req)');
    expect(source).toContain("row.scope === 'workspace'");
    expect(source).toContain("row.kind === 'gws' && row.provider === 'google'");
    expect(source).toContain("!Object.prototype.hasOwnProperty.call(row.metadata ?? {}, 'legacy_personal_owner_user_id')");
    expect(source).toContain('googleAccount:');
    expect(source).not.toContain("router.get('/connections/team-google', async (req, res) => {\n  const allowed = assertOperator(req)");
  });
});
