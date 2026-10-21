import { describe, expect, it } from 'vitest';
import {
  allowedProjectCredentialWhere,
  classifyRuntimeBoxFileCredential,
  credentialFileEnvNameForDefaultEnv,
  fileCredentialRequested,
  mergeRuntimeBoxApiKeyEnv,
} from './credential-vault-service.js';

describe('simplified Credential scope predicate', () => {
  it('automatically includes team-shared credentials', () => {
    expect(allowedProjectCredentialWhere('c', '$1')).toContain("c.scope = 'workspace'");
  });

  it('includes Agent credentials only when project_id matches', () => {
    const where = allowedProjectCredentialWhere('credential', '$7');
    expect(where).toContain("credential.scope = 'project'");
    expect(where).toContain("credential.project_id = $7");
  });

  it('does not reference retired policy, profile, or defaults tables', () => {
    const where = allowedProjectCredentialWhere('c', '$1');
    expect(where).not.toMatch(/internal-default|project_credential_policies|workspace_connection_defaults|profile|mode/);
  });
});

describe('mergeRuntimeBoxApiKeyEnv', () => {
  it('injects vault API keys into one command env', () => {
    const result = mergeRuntimeBoxApiKeyEnv({ existingEnv: { NODE_ENV: 'test' }, vaultEnv: [{ credentialId: 'gemini-default', envName: 'GEMINI_API_KEY', value: 'redacted-test-value' }] });
    expect(result.env).toEqual({ NODE_ENV: 'test', GEMINI_API_KEY: 'redacted-test-value' });
    expect(result.injected).toEqual([{ credentialId: 'gemini-default', envName: 'GEMINI_API_KEY' }]);
  });

  it('keeps caller env when the same key already exists', () => {
    const result = mergeRuntimeBoxApiKeyEnv({ existingEnv: { GEMINI_API_KEY: 'caller-value' }, vaultEnv: [{ credentialId: 'gemini-default', envName: 'GEMINI_API_KEY', value: 'vault-value' }] });
    expect(result.env.GEMINI_API_KEY).toBe('caller-value');
    expect(result.skippedExisting).toEqual([{ credentialId: 'gemini-default', envName: 'GEMINI_API_KEY' }]);
  });

  it('rejects invalid env names before injection', () => {
    expect(() => mergeRuntimeBoxApiKeyEnv({ vaultEnv: [{ credentialId: 'bad', envName: 'lowercase', value: 'value' }] })).toThrow(/invalid secret\/env name/);
  });
});

describe('Runtime Box file credential classification', () => {
  it('maps SSH private key env credentials to path env names', () => {
    expect(credentialFileEnvNameForDefaultEnv('N8N_OPS_SSH_PRIVATE_KEY')).toBe('N8N_OPS_SSH_KEY_FILE');
  });

  it('recognizes provider=ssh api_key credentials without a migration', () => {
    expect(classifyRuntimeBoxFileCredential({ credentialId: 'n8n-ops-ssh-private-key', provider: 'ssh', kind: 'api_key', secretName: 'N8N_OPS_SSH_PRIVATE_KEY', defaultEnvName: 'N8N_OPS_SSH_PRIVATE_KEY', targetEnvName: null, metadata: {} })).toEqual({ credentialType: 'ssh_private_key', envName: 'N8N_OPS_SSH_KEY_FILE', fileName: 'id_ssh', mode: '0600' });
  });

  it('selects an SSH file by either its stored private-key env or its materialized path env', () => {
    const input = { pathEnvName: 'MOAT_LLM_ROUTER_SSH_KEY_FILE', sourceEnvName: 'MOAT_LLM_ROUTER_SSH_PRIVATE_KEY' };
    expect(fileCredentialRequested({ ...input, requestedEnvNames: new Set(['MOAT_LLM_ROUTER_SSH_PRIVATE_KEY']) })).toBe(true);
    expect(fileCredentialRequested({ ...input, requestedEnvNames: new Set(['MOAT_LLM_ROUTER_SSH_KEY_FILE']) })).toBe(true);
    expect(fileCredentialRequested({ ...input, requestedEnvNames: new Set(['N8N_']) })).toBe(false);
  });

  it('prefers explicit metadata materialization settings', () => {
    expect(classifyRuntimeBoxFileCredential({ credentialId: 'custom-cert', provider: 'tls', kind: 'certificate', secretName: 'TLS_CERT', defaultEnvName: 'TLS_CERT', targetEnvName: null, metadata: { credential_type: 'ssh_private_key', materialization: { type: 'file', env_name: 'CUSTOM_KEY_FILE', filename: 'custom-key.pem', mode: '0400' } } })).toEqual({ credentialType: 'ssh_private_key', envName: 'CUSTOM_KEY_FILE', fileName: 'custom-key.pem', mode: '0400' });
  });
});
