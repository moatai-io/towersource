import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const executionGate = readFileSync(new URL('./execution-gate.ts', import.meta.url), 'utf8');
const projectAccess = readFileSync(new URL('../pm/project-access.ts', import.meta.url), 'utf8');
const credentialRoute = readFileSync(new URL('../../routes/credential-vault-api.ts', import.meta.url), 'utf8');

describe('canonical authorization policy consumers', () => {
  it('makes execution decisions explainable through policy and capability metadata', () => {
    expect(executionGate).toContain('AUTHORIZATION_POLICY_ID');
    expect(executionGate).toContain('requiredCapability: AuthorityCapability');
    expect(executionGate).toContain('authorizeTowerAction({');
  });

  it('does not reimplement admin/operator role checks in authority and project access modules', () => {
    expect(executionGate).not.toContain('isAdminOrOperatorRole(input.userRole)');
    expect(executionGate).not.toMatch(/userRole\s*===\s*['"]admin['"]\s*\|\|\s*[^\n]*userRole\s*===\s*['"]operator['"]/);

    expect(projectAccess).toMatch(/import \{[^}]*isAdminOrOperatorRole[^}]*\} from '\.\.\/authority\/authorization-policy\.js'/);
    expect(projectAccess).not.toMatch(/role\s*===\s*['"]admin['"]\s*\|\|\s*role\s*===\s*['"]operator['"]/);
  });

  it('keeps Credential Vault observation on the explicit operational helper', () => {
    const operatorGuard = credentialRoute.match(/function assertOperator\([\s\S]*?\n}/)?.[0] ?? '';
    expect(operatorGuard).toContain('isAdminOrOperator(');
    expect(operatorGuard).not.toContain('isPrivilegedRole');
  });
});
