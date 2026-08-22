import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const setup = fs.readFileSync(path.resolve(import.meta.dirname, './AgentGoogleConnectionSetup.tsx'), 'utf8');
const preview = fs.readFileSync(path.resolve(import.meta.dirname, './AgentDraftPreview.tsx'), 'utf8');

describe('Primary Agent Google setup during creation', () => {
  it('offers no connection, one organization account, or a dedicated Agent account', () => {
    expect(setup).toContain("t('agentCreation.google.none')");
    expect(setup).toContain("t('agentCreation.google.organization')");
    expect(setup).toContain("t('agentCreation.google.dedicated')");
    expect(setup).toContain("metadata?.connection_type === 'organization'");
    expect(setup).toContain("credential?.kind === 'gws'");
    expect(setup).toContain("credential?.provider === 'google'");
  });

  it('applies product-profile prominence separately from secret-free readiness', () => {
    expect(preview).toContain("googleConnection ?? 'hidden'");
    expect(preview).toContain("googleDisplayMode === 'inline'");
    expect(preview).toContain("googleDisplayMode === 'optional'");
    expect(preview).toContain("googleDisplayMode === 'hidden'");
    expect(preview).toContain("if (googleDisplayMode === 'hidden')");
  });

  it('gates Google choices on secret-free server readiness', () => {
    expect(setup).toContain("fetch('/api/auth/google/readiness'");
    expect(setup).toContain("disabled={loading || !googleReady || connections.length === 0}");
    expect(setup).toContain("disabled={loading || !googleReady}");
    expect(setup).toContain("readiness?.reason === 'https_required'");
    expect(setup).toContain('readiness.expectedRedirectUri');
    expect(preview).toContain('setOrganizationGoogleConnections(readiness.ready ? connections : [])');
    expect(preview).toContain("if (!readiness.ready) setGoogleSetup({ mode: 'none' })");
  });

  it('allows the selected organization Connection only after the new Project exists', () => {
    expect(preview.indexOf("fetch('/api/primary-agent-commands/bootstrap'")).toBeLessThan(preview.indexOf('allowOrganizationGoogleConnection(project.id'));
    expect(setup).toContain("body: JSON.stringify({ mode: 'allow'");
    expect(setup).toContain("granted_via: 'agent_creation'");
  });

  it('starts the Agent-bound OAuth flow with the newly created Project id', () => {
    expect(preview).toContain("googleSetup.mode === 'dedicated'");
    expect(preview).toContain('await startDedicatedGoogleOAuth(project.id)');
    expect(setup).toContain('fetch(`/api/auth/google/agent?projectId=');
    expect(setup).toContain("window.location.assign(result.url)");
    expect(setup).not.toContain('window.location.href = `/api/auth/google/agent?projectId=');
  });

  it('does not expose Credential internals in visible account labels', () => {
    expect(setup).toContain('connection.googleAccount || connection.displayName');
    expect(setup).not.toContain('secret_name');
    expect(setup).not.toContain('default_env_name');
  });
});
