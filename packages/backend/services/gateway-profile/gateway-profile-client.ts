import { query } from '../../db/pg-repo.js';
import { resolveProjectCredentialSecretValue } from '../credential-vault/credential-vault-service.js';

const DEFAULT_PROFILE_ID = 'tower-shared-api-v1';

export class GatewayProfileClientError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'GatewayProfileClientError';
  }
}

export type GatewayProfileClientConfig = {
  profileId: string;
  apiId: string;
  baseUrl: string;
  apiKey: string;
  credentialId: string;
  readiness: 'ready' | 'degraded' | 'unverified' | 'disabled';
};

export async function resolveGatewayApiClient(opts: {
  actorUserId: number;
  projectId: string;
  apiId: string;
  profileId?: string;
}): Promise<GatewayProfileClientConfig> {
  const profileId = opts.profileId ?? DEFAULT_PROFILE_ID;
  const rows = await query<any>(
    `SELECT gp.id, gp.gateway_base_url, gp.credential_id, gp.status,
            ce.api_id, ce.route_prefix, ce.readiness, ce.enabled
       FROM gateway_profiles gp
       LEFT JOIN gateway_profile_catalog_entries ce
         ON ce.profile_id = gp.id AND ce.api_id = $2
      WHERE gp.id = $1
      LIMIT 1`,
    [profileId, opts.apiId],
  );
  const profile = rows[0];
  if (!profile) throw new GatewayProfileClientError('Gateway Profile not found', 'GATEWAY_PROFILE_NOT_FOUND');
  if (!profile.gateway_base_url || !profile.credential_id) {
    throw new GatewayProfileClientError('Gateway Profile is not provisioned', 'GATEWAY_PROFILE_NOT_PROVISIONED');
  }
  if (profile.status === 'disabled') {
    throw new GatewayProfileClientError('Gateway Profile is disabled', 'GATEWAY_PROFILE_DISABLED');
  }
  if (!profile.api_id || profile.enabled !== true) {
    throw new GatewayProfileClientError('Gateway API is not allowed', 'GATEWAY_API_NOT_ALLOWED');
  }

  const credential = await resolveProjectCredentialSecretValue({
    projectId: opts.projectId,
    userId: opts.actorUserId,
    credentialId: profile.credential_id,
    kind: 'api_key',
    provider: 'zuplo',
    targetType: `gateway:${opts.apiId}`,
  });
  if (!credential) {
    throw new GatewayProfileClientError('Gateway Credential is not available to this Project', 'GATEWAY_CREDENTIAL_NOT_AVAILABLE');
  }
  return {
    profileId,
    apiId: profile.api_id,
    baseUrl: String(profile.gateway_base_url).replace(/\/$/, '') + String(profile.route_prefix),
    apiKey: credential.value,
    credentialId: credential.credentialId,
    readiness: profile.readiness,
  };
}

export async function resolveGatewayProfileClient(opts: {
  actorUserId: number;
  projectId: string;
  profileId?: string;
}): Promise<GatewayProfileClientConfig> {
  return resolveGatewayApiClient({ ...opts, apiId: 'openrouter-jev' });
}
