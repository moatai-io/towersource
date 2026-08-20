import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'AgentConnectionsPanel.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.join(__dirname, 'Sidebar.tsx'), 'utf8');

 describe('AgentConnectionsPanel source contract', () => {
  it('loads the secret-free Agent organization catalog', () => {
    expect(source).toContain('/connections/catalog');
    expect(source).toContain('AgentConnectionCatalog');
    expect(source).not.toContain('secretName');
    expect(source).not.toContain('secretValue');
    expect(source).not.toContain('defaultEnvName');
  });

  it('requires preview and explicit hash-confirmed apply', () => {
    expect(source).toContain('/preview`');
    expect(source).toContain('preview.intentId');
    expect(source).toContain('preview.proposalHash');
    expect(source).toContain('confirmed: true');
    expect(source).toContain('useConfirm');
  });

  it('shows accessible connected, blocked, available, loading, empty, and error states', () => {
    for (const token of ['connected', 'blocked', 'available', 'loadingConnections', 'noOrganizationConnections', 'tone-warning', 'tone-success', 'focus-visible:ring-2', 'min-h-10']) {
      expect(source).toContain(token);
    }
    expect(source).not.toContain('opacity-');
    expect(source).not.toMatch(/(?:text|bg|border)-(?:gray|slate)-/);
  });

  it('renders a credential group as one Connection with field completeness', () => {
    expect(source).toContain("source: 'profile' | 'credential' | 'group'");
    expect(source).toContain('fieldCount?: number');
    expect(source).toContain('connectedFieldCount?: number');
    expect(source).toContain('필수 필드 ${connection.connectedFieldCount ?? 0}/${connection.fieldCount}');
  });

  it('moves Connection management out of compact Agent settings into the dedicated Credential surface', () => {
    expect(sidebar).toContain("import { AgentCredentialsModal } from './AgentCredentialsModal'");
    expect(sidebar).toContain('<AgentCredentialsModal project={project} onClose={onClose} />');
    const settings = sidebar.slice(sidebar.indexOf('function ProjectSettingsPanel'));
    expect(settings).not.toContain('<AgentConnectionsPanel');
  });
});
