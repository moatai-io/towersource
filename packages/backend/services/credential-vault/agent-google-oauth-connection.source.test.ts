import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const api = readFileSync(new URL('../../routes/api.ts', import.meta.url), 'utf8');
const service = readFileSync(new URL('./credential-vault-service.ts', import.meta.url), 'utf8');
const manager = readFileSync(new URL('../runtime-box/runtime-box-manager.ts', import.meta.url), 'utf8');

describe('Agent-scoped Google OAuth Connection contract', () => {
  it('starts OAuth only with an authenticated Agent and credential target', () => {
    const start = api.slice(api.indexOf("router.get('/auth/google/agent'"), api.indexOf("router.get('/auth/google/callback'"));
    expect(start).toContain('authMiddleware');
    expect(start).toContain('assertAgentGoogleConnectionAccess');
    expect(start).toContain('projectId');
    expect(start).toContain('credentialId');
    expect(api).toContain("aud: 'google-agent-oauth-state'");
    expect(api).not.toContain("aud: 'google-oauth-state'");
  });

  it('binds callback storage to the exact Agent and Credential from signed state', () => {
    const callback = api.slice(api.indexOf("router.get('/auth/google/callback'"), api.indexOf('// Telegram Bot Linking'));
    expect(callback).toContain("payload?.aud === 'google-agent-oauth-state'");
    expect(callback).toContain("payload.connectionScope === 'agent'");
    expect(callback).toContain('payload.projectId');
    expect(callback).toContain('payload.credentialId');
    expect(callback).toContain('await upsertAgentGwsCredential');
    expect(callback).toContain('credentialId: payload.credentialId');
    expect(callback).not.toContain('savePersonalGwsConfigSecretFromToken');
    expect(callback).not.toContain('oauthManager.saveToken');
  });

  it('stores a project-scoped gws Credential and binds it as the one runtime default', () => {
    const upsert = service.slice(service.indexOf('export async function upsertAgentGwsCredential'), service.indexOf('/** Create or rotate an SSH private key'));
    expect(upsert).toContain("VALUES ($1, 'gws', 'google'");
    expect(upsert).toContain("'project'");
    expect(upsert).toContain("connection_type: 'agent'");
    expect(upsert).toContain('agent_project_id: opts.projectId');
    expect(upsert).toContain("credential_type_id: 'google_oauth'");
    expect(upsert).toContain("metadata = COALESCE(metadata, '{}'::jsonb) - 'runtime_default'");
    expect(upsert).toContain('runtime_default: true');
    expect(upsert).toContain('await setProjectCredentialPolicy');
  });

  it('keeps Runtime selection Agent-bound and fail-closed', () => {
    expect(manager).toContain('selectProjectGwsConnection');
    expect(manager).toContain('AMBIGUOUS_GWS_CONNECTION');
    expect(manager).toContain('GWS_CONNECTION_NOT_ALLOWED');
    expect(manager).toContain("c.kind = 'gws'");
    expect(manager).toContain("c.provider = 'google'");
  });
});
