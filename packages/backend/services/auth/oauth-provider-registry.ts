/**
 * oauth-provider-registry.ts — Owns the user-facing catalog of OAuth connections.
 *
 * Adding a provider starts here: declare its label, capabilities, and whether
 * the server-side OAuth client is configured. The provider-specific auth route
 * and token refresher remain in the provider module.
 */

import { isGoogleOAuthConfigured } from './google-oauth.js';

export interface OAuthProviderDescriptor {
  id: string;
  label: string;
  description: string;
  configured: boolean;
  authPath: string;
  capabilities: string[];
  runtimeCredential?: {
    kind: string;
    envName: string;
  };
}

/** Return OAuth providers that the Tower UI can offer as account connections. */
export function listOAuthProviders(): OAuthProviderDescriptor[] {
  return [
    {
      id: 'google',
      label: 'Google Workspace',
      description: 'Gmail, Calendar, Drive를 내 Google 계정 권한으로 사용합니다.',
      configured: isGoogleOAuthConfigured(),
      authPath: '/api/auth/google',
      capabilities: ['Gmail 읽기·초안·발송', 'Calendar 읽기', 'Drive 읽기'],
      runtimeCredential: {
        kind: 'gws_config',
        envName: 'GWS_CONFIG_HOME',
      },
    },
  ];
}

/** Only declared providers may be disconnected through the generic endpoint. */
export function findOAuthProvider(providerId: string): OAuthProviderDescriptor | undefined {
  return listOAuthProviders().find(provider => provider.id === providerId);
}
