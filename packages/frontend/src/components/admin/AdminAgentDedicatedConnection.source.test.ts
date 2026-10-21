import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'AdminPanel.tsx'), 'utf8');

describe('Admin and Agent Connection boundary', () => {
  it('shows VM-wide inventory while keeping Agent Credentials project-owned until promotion', () => {
    const credentials = source.slice(source.indexOf('function CredentialVaultManagement'), source.indexOf('// ───── System Tab'));
    expect(credentials).toContain("credential.scope === 'workspace'");
    expect(credentials).toContain("credential.scope === 'project'");
    expect(credentials).toContain('credentialConnections.agentCredentials');
    expect(credentials).toContain('promoteCredential');
    expect(credentials).not.toContain('dedicatedProjectId');
  });
});
