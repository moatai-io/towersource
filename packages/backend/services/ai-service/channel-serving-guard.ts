/**
 * Owns DB-backed serving guards for token-authenticated AI Service Channels.
 * Public API: revokeChannelCredential, assertChannelCredentialNotRevoked, enforceChannelQuota.
 */
import { execute, queryOne } from '../../db/pg-repo.js';
import { ChannelCredentialError, channelCredentialTokenHash, type ChannelCredentialClaims } from './channel-credential.js';

interface ChannelConfigRow { config: Record<string, unknown> | null }
interface CountRow { count: string }

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function quotaConfig(config: Record<string, unknown> | null | undefined) {
  const raw = config?.publicQuota && typeof config.publicQuota === 'object' && !Array.isArray(config.publicQuota)
    ? config.publicQuota as Record<string, unknown>
    : {};
  return {
    perChannelPerMinute: positiveInt(raw.perChannelPerMinute, 120),
    perTenantPerMinute: positiveInt(raw.perTenantPerMinute, 30),
    perTenantPerDay: positiveInt(raw.perTenantPerDay, 1000),
  };
}

export async function revokeChannelCredential(input: {
  token: string;
  claims: ChannelCredentialClaims;
  revokedByUserId?: number | null;
  reason?: string;
}): Promise<void> {
  await execute(
    `INSERT INTO ai_service_channel_credential_revocations
       (token_hash, service_id, channel_id, nonce, reason, revoked_by_user_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7))
     ON CONFLICT(token_hash) DO NOTHING`,
    [
      channelCredentialTokenHash(input.token),
      input.claims.serviceId,
      input.claims.channelId,
      input.claims.nonce,
      input.reason || 'revoked',
      input.revokedByUserId || null,
      input.claims.exp,
    ],
  );
}

export async function assertChannelCredentialNotRevoked(token: string): Promise<void> {
  const row = await queryOne<{ id: string }>(
    'SELECT id FROM ai_service_channel_credential_revocations WHERE token_hash=$1 LIMIT 1',
    [channelCredentialTokenHash(token)],
  );
  if (row) throw new ChannelCredentialError('AI Service Channel credential revoked', 401);
}

export async function enforceChannelQuota(claims: ChannelCredentialClaims): Promise<void> {
  const channel = await queryOne<ChannelConfigRow>('SELECT config FROM ai_service_channels WHERE id=$1 AND service_id=$2', [claims.channelId, claims.serviceId]);
  const quota = quotaConfig(channel?.config || null);
  const [channelMinute, tenantMinute, tenantDay] = await Promise.all([
    queryOne<CountRow>(
      `SELECT COUNT(*) AS count FROM ai_service_channel_usage_events
        WHERE service_id=$1 AND channel_id=$2 AND event_type='message_turn' AND created_at > NOW() - INTERVAL '1 minute'`,
      [claims.serviceId, claims.channelId],
    ),
    queryOne<CountRow>(
      `SELECT COUNT(*) AS count FROM ai_service_channel_usage_events
        WHERE service_id=$1 AND channel_id=$2 AND tenant_key=$3 AND event_type='message_turn' AND created_at > NOW() - INTERVAL '1 minute'`,
      [claims.serviceId, claims.channelId, claims.tenantKey],
    ),
    queryOne<CountRow>(
      `SELECT COUNT(*) AS count FROM ai_service_channel_usage_events
        WHERE service_id=$1 AND channel_id=$2 AND tenant_key=$3 AND event_type='message_turn' AND created_at > NOW() - INTERVAL '1 day'`,
      [claims.serviceId, claims.channelId, claims.tenantKey],
    ),
  ]);
  if (Number(channelMinute?.count || 0) >= quota.perChannelPerMinute) throw new ChannelCredentialError('AI Service Channel quota exceeded: channel per-minute limit', 429);
  if (Number(tenantMinute?.count || 0) >= quota.perTenantPerMinute) throw new ChannelCredentialError('AI Service Channel quota exceeded: tenant per-minute limit', 429);
  if (Number(tenantDay?.count || 0) >= quota.perTenantPerDay) throw new ChannelCredentialError('AI Service Channel quota exceeded: tenant daily limit', 429);
}
