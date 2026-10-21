import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './credential-vault-api.ts'), 'utf8');

describe('Simplified Agent Google Connection catalog', () => {
  it('returns VM-team shared and current-Agent dedicated credentials in one catalog', () => {
    expect(source).toContain("allowedProjectCredentialWhere('c', '$1')");
    expect(source).toContain("connectionScope: row.scope === 'workspace' ? 'team_shared' : 'agent_dedicated'");
  });

  it('removes per-Agent Google default selection policy', () => {
    expect(source).not.toContain('/google-connections/:credentialId/default');
    expect(source).not.toContain('runtime_default');
    expect(source).not.toContain('project_credential_policies');
  });
});
