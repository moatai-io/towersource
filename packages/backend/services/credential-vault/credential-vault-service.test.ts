/**
 * credential-vault-service.test.ts — deterministic Credential Vault helpers.
 *
 * DB-backed tests for policy resolution and secret_store decryption belong in
 * integration. Here we pin the security-sensitive env merge semantics.
 */

import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_BUNDLE_TYPES,
  allowedProjectCredentialWhere,
  classifyRuntimeBoxFileCredential,
  credentialFileEnvNameForDefaultEnv,
  mergeRuntimeBoxApiKeyEnv,
} from './credential-vault-service.js';

describe('allowedProjectCredentialWhere', () => {
  it('treats workspace/internal-default credentials as inherited unless denied', () => {
    const where = allowedProjectCredentialWhere('c', 'p');

    expect(where).toContain("p.mode IN ('allow', 'override', 'inherit')");
    expect(where).toContain("d.enabled = true");
    expect(where).toContain("d.connection_id IS NULL AND c.scope IN ('workspace', 'internal-default')");
    expect(where).not.toContain("c.scope IN ('project')");
  });

  it('uses explicit Agent binding rather than personal owner identity for Runtime authority', () => {
    const where = allowedProjectCredentialWhere('c', 'p', 'd', 'prj');

    expect(where).toContain("p.mode IN ('allow', 'override', 'inherit')");
    expect(where).not.toContain('owner_user_id');
    expect(where).toContain("d.connection_id IS NULL AND c.scope IN ('workspace', 'internal-default')");
  });

  it('never default-inherits personal credentials and leaves explicit deny blocked', () => {
    const where = allowedProjectCredentialWhere('c', 'p', 'd', 'prj');

    expect(where).toContain("c.scope <> 'personal'");
    expect(where).not.toContain("c.scope IN ('workspace', 'internal-default', 'personal')");
    expect(where).not.toContain("p.mode = 'deny'");
  });
});

describe('mergeRuntimeBoxApiKeyEnv', () => {
  it('injects vault API keys into one command env', () => {
    const result = mergeRuntimeBoxApiKeyEnv({
      existingEnv: { NODE_ENV: 'test' },
      vaultEnv: [
        { credentialId: 'gemini-default', envName: 'GEMINI_API_KEY', value: 'redacted-test-value' },
      ],
    });

    expect(result.env.NODE_ENV).toBe('test');
    expect(result.env.GEMINI_API_KEY).toBe('redacted-test-value');
    expect(result.injected).toEqual([{ credentialId: 'gemini-default', envName: 'GEMINI_API_KEY' }]);
    expect(result.skippedExisting).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('keeps caller env when the same key already exists', () => {
    const result = mergeRuntimeBoxApiKeyEnv({
      existingEnv: { GEMINI_API_KEY: 'caller-value' },
      vaultEnv: [
        { credentialId: 'gemini-default', envName: 'GEMINI_API_KEY', value: 'vault-value' },
      ],
    });

    expect(result.env.GEMINI_API_KEY).toBe('caller-value');
    expect(result.injected).toEqual([]);
    expect(result.skippedExisting).toEqual([{ credentialId: 'gemini-default', envName: 'GEMINI_API_KEY' }]);
    expect(result.skipped).toEqual([]);
  });

  it('rejects invalid env names before injection', () => {
    expect(() => mergeRuntimeBoxApiKeyEnv({
      vaultEnv: [
        { credentialId: 'bad', envName: 'lowercase', value: 'value' },
      ],
    })).toThrow(/invalid secret\/env name/);
  });
});

describe('CREDENTIAL_BUNDLE_TYPES', () => {
  it('stores web login username/password as editable secret env references', () => {
    const webLogin = CREDENTIAL_BUNDLE_TYPES.find((type) => type.id === 'web-login');

    expect(webLogin?.fields.map((field) => [field.id, field.envName, field.secret, field.envNameEditable])).toEqual([
      ['username', 'WEB_LOGIN_USERNAME', true, true],
      ['password', 'WEB_LOGIN_PASSWORD', true, true],
    ]);
  });

  it('stores every Aligo SMS runtime env as a secret reference', () => {
    const aligo = CREDENTIAL_BUNDLE_TYPES.find((type) => type.id === 'aligo-sms');

    expect(aligo?.fields.map((field) => [field.envName, field.secret])).toEqual([
      ['ALIGO_API_KEY', true],
      ['ALIGO_USER_ID', true],
      ['ALIGO_SENDER', true],
    ]);
  });
});

describe('Runtime Box file credential classification', () => {
  it('maps SSH private key env credentials to path env names', () => {
    expect(credentialFileEnvNameForDefaultEnv('N8N_OPS_SSH_PRIVATE_KEY')).toBe('N8N_OPS_SSH_KEY_FILE');
  });

  it('recognizes legacy provider=ssh api_key credentials without metadata migration', () => {
    const result = classifyRuntimeBoxFileCredential({
      credentialId: 'n8n-ops-ssh-private-key',
      provider: 'ssh',
      kind: 'api_key',
      secretName: 'N8N_OPS_SSH_PRIVATE_KEY',
      defaultEnvName: 'N8N_OPS_SSH_PRIVATE_KEY',
      targetEnvName: null,
      metadata: {},
    });

    expect(result).toEqual({
      credentialType: 'ssh_private_key',
      envName: 'N8N_OPS_SSH_KEY_FILE',
      fileName: 'id_ssh',
      mode: '0600',
    });
  });

  it('prefers explicit metadata materialization settings', () => {
    const result = classifyRuntimeBoxFileCredential({
      credentialId: 'custom-cert',
      provider: 'tls',
      kind: 'certificate',
      secretName: 'TLS_CERT',
      defaultEnvName: 'TLS_CERT',
      targetEnvName: null,
      metadata: {
        credential_type: 'ssh_private_key',
        materialization: { type: 'file', env_name: 'CUSTOM_KEY_FILE', filename: 'custom-key.pem', mode: '0400' },
      },
    });

    expect(result).toEqual({
      credentialType: 'ssh_private_key',
      envName: 'CUSTOM_KEY_FILE',
      fileName: 'custom-key.pem',
      mode: '0400',
    });
  });
});
