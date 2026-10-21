import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const admin = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
const agent = readFileSync(new URL('../layout/AgentConnectionsPanel.tsx', import.meta.url), 'utf8');

describe('Connection ownership split', () => {
  it('removes Agent project policies from Admin shared Connection management', () => {
    const credentials = admin.slice(admin.indexOf('function CredentialVaultManagement'), admin.indexOf('// ───── System Tab'));
    expect(credentials).not.toContain('connectionProjectErrors');
    expect(credentials).not.toContain('project-policies');
    expect(credentials).not.toContain('/connections/${encodeURIComponent(connection.id)}/projects/');
  });

  it('shows VM-team shared Connections as automatically available from the Agent panel', () => {
    expect(agent).toContain("connection.connectionScope === 'agent_dedicated'");
    expect(agent).not.toContain('/connections/${encodeURIComponent(connection.id)}/projects/${encodeURIComponent(projectId)}');
    expect(agent).not.toContain("JSON.stringify({ mode })");
  });
});
