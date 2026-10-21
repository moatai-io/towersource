import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const modal = fs.readFileSync(path.join(import.meta.dirname, 'AgentCredentialsModal.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.join(import.meta.dirname, 'Sidebar.tsx'), 'utf8');
const connections = fs.readFileSync(path.join(import.meta.dirname, 'AgentConnectionsPanel.tsx'), 'utf8');

describe('Agent Credential simplified management surface', () => {
  it('keeps secure chat registration guidance', () => {
    expect(modal).toContain("t('agentCredentials.chatInjectionNotice')");
  });

  it('uses the single Agent settings menu for Connection management and removes legacy Project settings', () => {
    expect(sidebar).toContain("t('settings')");
    expect(sidebar).toContain('setShowCredentials(true)');
    expect(sidebar).not.toContain('function ProjectSettingsPanel');
    expect(sidebar).not.toContain('setShowSettings(true)');
  });

  it('supports direct Agent Connection registration and replacement', () => {
    expect(modal).toContain('<AgentConnectionsPanel projectId={project.id} spacious hideAgentConnections view={addMethod} />');
    expect(modal).toContain('/credentials/api-key`');
    expect(modal).toContain("scope: 'project'");
    expect(modal).toContain('/credentials/${encodeURIComponent(editing.id)}/rotate`');
    expect(modal).toContain("t('agentCredentials.edit')");
    expect(modal).toContain("t('agentCredentials.reauthenticate')");
  });

  it('supports immediate enable, disable, and delete without reveal or inspect', () => {
    expect(modal).toContain('/credentials/${encodeURIComponent(credential.id)}`');
    expect(modal).toContain("method: 'DELETE'");
    expect(modal).toContain("t('agentCredentials.enable')");
    expect(modal).toContain("t('agentCredentials.disable')");
    expect(modal).toContain("t('agentCredentials.delete')");
    expect(modal).not.toContain('/reveal');
    expect(modal).not.toContain('/inspect');
    expect(modal).not.toContain('rawMaskNotice');
  });

  it('keeps secrets out of files/chat and supports keyboard dismissal', () => {
    expect(modal).toContain("t('agentCredentials.securityNotice')");
    expect(modal).toContain("event.key === 'Escape'");
    expect(modal).toContain('role="dialog"');
    expect(modal).toContain('aria-modal="true"');
    expect(modal).toContain('focus-visible:ring-2');
    expect(modal).not.toMatch(/(?:text|bg|border)-(?:gray|slate)-/);
  });

  it('offers a spacious Connection layout without changing compact reuse', () => {
    expect(connections).toContain('spacious = false');
    expect(connections).toContain("spacious ? 'grid gap-3 sm:grid-cols-2' : 'space-y-2'");
  });
});
