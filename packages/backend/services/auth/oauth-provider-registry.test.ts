import { describe, expect, it } from 'vitest';
import { findOAuthProvider, listOAuthProviders } from './oauth-provider-registry.js';

describe('OAuth provider registry', () => {
  it('declares Google Workspace as an OAuth account with Runtime Box materialization metadata', () => {
    const google = findOAuthProvider('google');

    expect(google).toMatchObject({
      id: 'google',
      authPath: '/api/auth/google',
      runtimeCredential: {
        kind: 'gws_config',
        envName: 'GWS_CONFIG_HOME',
      },
    });
    expect(google?.capabilities).toContain('Gmail 읽기·초안·발송');
  });

  it('returns only uniquely identified providers', () => {
    const providers = listOAuthProviders();
    expect(new Set(providers.map(provider => provider.id)).size).toBe(providers.length);
  });
});
