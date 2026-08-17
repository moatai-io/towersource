import { describe, expect, it } from 'vitest';
import { assertRevealAllowed, credentialAllowedActions, credentialRevealPolicy } from './credential-reveal-policy.js';

describe('credential reveal policy', () => {
  it('allows ordinary API keys and passwords', () => {
    expect(credentialRevealPolicy({ kind: 'api_key', secretName: 'OPENAI_API_KEY' })).toBe('allow');
    expect(credentialRevealPolicy({ kind: 'password', secretName: 'SERVICE_PASSWORD' })).toBe('allow');
  });

  it('forbids OAuth tokens and SSH private keys', () => {
    expect(credentialRevealPolicy({ kind: 'oauth', secretName: 'GOOGLE_ACCESS_TOKEN' })).toBe('deny');
    expect(credentialRevealPolicy({ kind: 'ssh_private_key', secretName: 'DEPLOY_PRIVATE_KEY' })).toBe('deny');
    expect(() => assertRevealAllowed({ kind: 'oauth', secretName: 'GOOGLE_REFRESH_TOKEN' }, 'reveal')).toThrow('Credential type cannot be revealed');
  });

  it('publishes UI actions from the same reveal policy', () => {
    expect(credentialAllowedActions({ kind: 'api_key', secretName: 'OPENAI_API_KEY' })).toMatchObject({ compare: true, reveal: true, reason: 'ordinary_secret' });
    expect(credentialAllowedActions({ kind: 'oauth', secretName: 'GOOGLE_ACCESS_TOKEN' })).toMatchObject({ compare: false, reveal: false, replacementAction: 'reauth', reason: 'oauth_token' });
    expect(credentialAllowedActions({ kind: 'ssh_private_key', secretName: 'DEPLOY_PRIVATE_KEY' })).toMatchObject({ compare: false, reveal: false, replacementAction: 'rotate', reason: 'ssh_private_key' });
  });

  it('allows structured inspection but never full JSON reveal', () => {
    const descriptor = { kind: 'credential_json', secretName: 'SERVICE_CREDENTIALS_JSON' };
    expect(credentialRevealPolicy(descriptor)).toBe('masked_json');
    expect(assertRevealAllowed(descriptor, 'inspect')).toBe('masked_json');
    expect(() => assertRevealAllowed(descriptor, 'reveal')).toThrow('Structured Credential cannot be revealed in full');
  });
});
