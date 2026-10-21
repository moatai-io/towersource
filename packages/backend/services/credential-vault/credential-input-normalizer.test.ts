import { describe, expect, it } from 'vitest';
import { CredentialInputError, inferSecretPolicy, normalizeSecretInput } from './credential-input-normalizer.js';

describe('credential input normalizer', () => {
  it('normalizes pasted bearer tokens to a raw token', () => {
    const policy = inferSecretPolicy({ fieldId: 'api_key', envName: 'OPENAI_API_KEY' });
    expect(normalizeSecretInput('  Bearer   abc123  ', policy)).toEqual({
      value: 'abc123',
      normalizations: ['removed_outer_whitespace', 'removed_authorization_scheme'],
    });
  });

  it('rejects missing, multiline, and internally spaced tokens', () => {
    const policy = inferSecretPolicy({ fieldId: 'token', envName: 'SERVICE_TOKEN' });
    for (const value of ['Bearer', 'abc\nextra', 'abc 123']) {
      expect(() => normalizeSecretInput(value, policy)).toThrow(CredentialInputError);
    }
  });

  it('does not trim passwords because whitespace may be significant', () => {
    const policy = inferSecretPolicy({ fieldId: 'password', envName: 'WEB_LOGIN_PASSWORD' });
    expect(normalizeSecretInput(' password ', policy)).toEqual({ value: ' password ', normalizations: [] });
  });

  it('normalizes private key line endings and validates the envelope', () => {
    const policy = inferSecretPolicy({ credentialType: 'ssh_private_key' });
    const privateKey = ['-----BEGIN OPENSSH ' + 'PRIVATE KEY-----', 'abc', '-----END OPENSSH ' + 'PRIVATE KEY-----'].join('\r\n');
    const result = normalizeSecretInput(` \r\n${privateKey}\r\n `, policy);
    expect(result.value).not.toContain('\r');
    expect(result.normalizations).toEqual(['normalized_line_endings', 'removed_outer_whitespace']);
    expect(() => normalizeSecretInput('not a key', policy)).toThrow('header or footer');
  });

  it('recognizes non-SSH PEM env names before the generic api_key field', () => {
    const policy = inferSecretPolicy({ provider: 'github', fieldId: 'api_key', envName: 'TOWER_FEEDBACK_GITHUB_PRIVATE_KEY' });
    expect(policy.inputKind).toBe('private_key');
    const pem = ['-----BEGIN RSA ' + 'PRIVATE KEY-----', 'synthetic-test-body', '-----END RSA ' + 'PRIVATE KEY-----'].join('\n');
    expect(normalizeSecretInput(pem, policy).value).toBe(pem);
    expect(() => normalizeSecretInput('not a PEM', policy)).toThrow('header or footer');
    expect(inferSecretPolicy({ credentialType: 'private_key', fieldId: 'api_key' }).inputKind).toBe('private_key');
    expect(inferSecretPolicy({ provider: 'github', fieldId: 'api_key', envName: 'GH_TOKEN' }).rejectInternalWhitespace).toBe(true);
  });

  it('canonicalizes JSON credentials without exposing values in metadata', () => {
    const policy = inferSecretPolicy({ fieldId: 'credentials_json' });
    const result = normalizeSecretInput(' { "token": "secret" } ', policy);
    expect(result.value).toBe('{"token":"secret"}');
    expect(result.normalizations).toContain('canonicalized_json');
    expect(result.normalizations.join(' ')).not.toContain('secret');
  });
});
