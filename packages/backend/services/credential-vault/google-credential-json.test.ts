import { describe, expect, it } from 'vitest';
import { decodeAgentGwsBundle } from '../runtime-box/agent-gws-credential-selection.js';
import { validateAndBundleGoogleCredentialJson } from './google-credential-json.js';

const authorized = { type: 'authorized_user', client_id: 'client', client_secret: 'secret', refresh_token: 'refresh' };
const service = { type: 'service_account', project_id: 'project', private_key_id: 'key-id', private_key: '-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----\n', client_email: 'agent@example.invalid', token_uri: 'https://oauth2.googleapis.com/token' };

describe('Google credential JSON validation and GWS packaging', () => {
  it.each([[authorized, 'authorized_user'], [service, 'service_account']] as const)('packages supported %s credentials as one root file', (input, type) => {
    const result = validateAndBundleGoogleCredentialJson(JSON.stringify(input, null, 2));
    expect(result.type).toBe(type);
    const files = decodeAgentGwsBundle(result.encodedGwsBundle);
    expect(files.map(file => file.name)).toEqual(['credentials.json']);
    expect(JSON.parse(files[0].content.toString())).toMatchObject({ type });
    expect(result.encodedGwsBundle).not.toContain('synthetic');
  });
  it.each([
    {}, { type: 'external_account' }, { ...authorized, refresh_token: '' },
    { ...service, private_key: 'not-a-private-key' }, { ...service, client_email: '' },
  ])('rejects unsupported or incomplete Google credentials', input => {
    expect(() => validateAndBundleGoogleCredentialJson(JSON.stringify(input))).toThrow();
  });
  it('does not expose credential values in validation errors', () => {
    expect(() => validateAndBundleGoogleCredentialJson('{"type":"service_account","private_key":"private-sensitive"}')).toThrow('missing project_id');
    try { validateAndBundleGoogleCredentialJson('{"type":"service_account","private_key":"private-sensitive"}'); }
    catch (error) { expect(String(error)).not.toContain('private-sensitive'); }
  });
});
