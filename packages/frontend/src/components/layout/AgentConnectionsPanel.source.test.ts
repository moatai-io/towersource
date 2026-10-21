import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'AgentConnectionsPanel.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.join(__dirname, 'Sidebar.tsx'), 'utf8');

describe('AgentConnectionsPanel simplified contract', () => {
  it('loads the secret-free Agent Connection catalog', () => {
    expect(source).toContain('/connections/catalog');
    expect(source).toContain('AgentConnectionCatalog');
    expect(source).not.toContain('secretName');
    expect(source).not.toContain('secretValue');
  });

  it('treats team shared Connections as automatically available', () => {
    expect(source).toContain("connection.connectionScope === 'agent_dedicated'");
    expect(source).not.toContain('/connections/${encodeURIComponent(connection.id)}/projects/${encodeURIComponent(projectId)}');
    expect(source).not.toContain("JSON.stringify({ mode })");
    expect(source).not.toContain('/preview`');
    expect(source).not.toContain('/apply`');
    expect(source).not.toContain('proposalHash');
    expect(source).not.toContain('intentId');
    expect(source).not.toContain('useConfirm');
  });

  it('separates Agent-only and team shared Connections', () => {
    expect(source).toContain("connection.origin === 'agent'");
    expect(source).toContain("'agentGoogle.agentAccountsTitle'");
    expect(source).toContain("t('agentGoogle.organizationAccountsTitle')");
    expect(source).not.toContain('isDefault');
    expect(source).not.toContain('/default');
  });

  it('keeps accessible status, loading, empty, and error states', () => {
    for (const token of ['connected', 'blocked', 'available', 'loadingConnections', 'noOrganizationConnections', 'tone-warning', 'tone-success', 'focus-visible:ring-2', 'min-h-10']) expect(source).toContain(token);
    expect(source).not.toMatch(/(?:text|bg|border)-(?:gray|slate)-/);
  });

  it('moves Connection management into the dedicated lazy-loaded Agent Credential surface', () => {
    expect(sidebar).toContain("const AgentCredentialsModal = React.lazy(() => import('./AgentCredentialsModal')");
    expect(sidebar).toContain('<React.Suspense fallback={null}><AgentCredentialsModal project={project} onClose={onClose} /></React.Suspense>');
    expect(sidebar).not.toContain('function ProjectSettingsPanel');
    expect(sidebar).not.toContain('setShowSettings(true)');
  });
});
