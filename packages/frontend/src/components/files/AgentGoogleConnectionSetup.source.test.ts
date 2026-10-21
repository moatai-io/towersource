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
    expect(setup).toContain("fetch('/api/credential-vault/connections/team-google'");
  });

  it('applies product-profile prominence separately from secret-free readiness', () => {
    expect(preview).toContain("googleConnection ?? 'hidden'");
    expect(preview).toContain("googleDisplayMode === 'inline'");
    expect(preview).toContain("googleDisplayMode === 'optional'");
    expect(preview).toContain("googleDisplayMode === 'hidden'");
    expect(preview).toContain("if (googleDisplayMode === 'hidden')");
  });

  it('gates only new dedicated OAuth on server readiness while existing organization accounts remain selectable', () => {
    expect(setup).toContain("fetch('/api/auth/google/readiness'");
    expect(setup).toContain("disabled={loading || connections.length === 0}");
    expect(setup).toContain('checked={value.mode === \'dedicated\'} disabled={loading}');
    expect(setup).toContain("value.mode === 'dedicated' && !loading && !googleReady");
    expect(setup).not.toContain('{!loading && !googleReady && (');
    expect(setup).toContain("readiness?.reason === 'https_required'");
    expect(setup).toContain('readiness.expectedRedirectUri');
    expect(preview).toContain('setOrganizationGoogleConnections(connections)');
    expect(preview).toContain("current.mode === 'dedicated' ? { mode: 'none' } : current");
    expect(preview).toContain("googleSetup.mode === 'dedicated' && googleOAuthReadiness?.ready !== true");
  });

  it('uses team-shared organization Connections without a removed per-Project policy call', () => {
    expect(setup).toContain("fetch('/api/credential-vault/connections/team-google'");
    expect(setup).not.toContain('/policies/');
    expect(preview).not.toContain('allowOrganizationGoogleConnection');
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
