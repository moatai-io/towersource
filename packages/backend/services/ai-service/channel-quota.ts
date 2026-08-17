/**
 * Owns lightweight DB-backed quota enforcement for AI Service public Channel serving.
 * Public API: assertChannelQuota, getChannelQuotaLimits, getChannelQuotaConfig, updateChannelQuotaConfig.
 */
import { queryOne } from '../../db/pg-repo.js';
import { ChannelCredentialError } from './channel-credential.js';

const DEFAULT_WINDOW_SECONDS = 60;
const DEFAULT_CHANNEL_LIMIT = Number(process.env.AI_SERVICE_CHANNEL_PER_MINUTE_LIMIT || 120);
const DEFAULT_TENANT_LIMIT = Number(process.env.AI_SERVICE_TENANT_PER_MINUTE_LIMIT || 30);
const DEFAULT_TENANT_DAILY_LIMIT = Number(process.env.AI_SERVICE_TENANT_DAILY_LIMIT || 1000);
const DEFAULT_TOKEN_LIMIT = Number(process.env.AI_SERVICE_TOKEN_LIMIT || 1_000_000);

export interface ChannelQuotaLimits {
  windowSeconds: number;
  channelLimit: number;
  tenantLimit: number;
  tenantDailyLimit: number;
  tokenLimit: number;
}

interface ChannelQuotaConfigRow {
  config: Record<string, unknown> | null;
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function rawQuotaFromConfig(config: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  const servingQuota = config.servingQuota;
  if (servingQuota && typeof servingQuota === 'object' && !Array.isArray(servingQuota)) return servingQuota as Record<string, unknown>;
  const legacyPublicQuota = config.publicQuota;
  if (legacyPublicQuota && typeof legacyPublicQuota === 'object' && !Array.isArray(legacyPublicQuota)) return legacyPublicQuota as Record<string, unknown>;
  return {};
}

export function getChannelQuotaLimits(input: {
  channelLimit?: number;
  tenantLimit?: number;
  tenantDailyLimit?: number;
  tokenLimit?: number;
  windowSeconds?: number;
  config?: Record<string, unknown> | null;
} = {}): ChannelQuotaLimits {
  const raw = rawQuotaFromConfig(input.config);
  return {
    windowSeconds: positiveInt(input.windowSeconds ?? raw.windowSeconds, DEFAULT_WINDOW_SECONDS),
    channelLimit: positiveInt(input.channelLimit ?? raw.channelLimit ?? raw.perChannelPerMinute, DEFAULT_CHANNEL_LIMIT),
    tenantLimit: positiveInt(input.tenantLimit ?? raw.tenantLimit ?? raw.perTenantPerMinute, DEFAULT_TENANT_LIMIT),
    tenantDailyLimit: positiveInt(input.tenantDailyLimit ?? raw.tenantDailyLimit ?? raw.perTenantPerDay, DEFAULT_TENANT_DAILY_LIMIT),
    tokenLimit: positiveInt(input.tokenLimit ?? raw.tokenLimit, DEFAULT_TOKEN_LIMIT),
  };
}

export async function getChannelQuotaConfig(input: { serviceId: string; channelId: string }): Promise<ChannelQuotaLimits> {
  const row = await queryOne<ChannelQuotaConfigRow>('SELECT config FROM ai_service_channels WHERE id=$1 AND service_id=$2', [input.channelId, input.serviceId]);
  return getChannelQuotaLimits({ config: row?.config || null });
}

export async function updateChannelQuotaConfig(input: {
  serviceId: string;
  channelId: string;
  limits: Partial<ChannelQuotaLimits>;
}): Promise<ChannelQuotaLimits> {
  const next = getChannelQuotaLimits(input.limits);
  const row = await queryOne<ChannelQuotaConfigRow>(
    `UPDATE ai_service_channels
        SET config=jsonb_set(COALESCE(config,'{}'::jsonb), '{servingQuota}', $3::jsonb, true), updated_at=NOW()
      WHERE id=$1 AND service_id=$2
      RETURNING config`,
    [input.channelId, input.serviceId, JSON.stringify(next)],
  );
  if (!row) throw new ChannelCredentialError('AI Service Channel not found', 404);
  return getChannelQuotaLimits({ config: row.config });
}

export class ChannelQuotaError extends ChannelCredentialError {
  constructor(message: string) {
    super(message, 429);
    this.name = 'ChannelQuotaError';
  }
}

export async function assertChannelQuota(input: {
  serviceId: string;
  channelId: string;
  tenantKey: string;
  windowSeconds?: number;
  channelLimit?: number;
  tenantLimit?: number;
  tenantDailyLimit?: number;
  tokenLimit?: number;
}): Promise<void> {
  const configured = await getChannelQuotaConfig(input);
  const { windowSeconds, channelLimit, tenantLimit, tenantDailyLimit, tokenLimit } = getChannelQuotaLimits({ ...configured, ...input });
  const row = await queryOne<{ channel_count: string; tenant_count: string; tenant_daily_count: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE event_type='message_turn' AND created_at > NOW() - ($4::int * INTERVAL '1 second')) AS channel_count,
       COUNT(*) FILTER (WHERE event_type='message_turn' AND tenant_key=$3 AND created_at > NOW() - ($4::int * INTERVAL '1 second')) AS tenant_count,
       COUNT(*) FILTER (WHERE event_type='message_turn' AND tenant_key=$3 AND created_at > NOW() - INTERVAL '1 day') AS tenant_daily_count
       FROM ai_service_channel_usage_events
      WHERE service_id=$1 AND channel_id=$2`,
    [input.serviceId, input.channelId, input.tenantKey, windowSeconds],
  );
  const channelCount = Number(row?.channel_count || 0);
  const tenantCount = Number(row?.tenant_count || 0);
  const tenantDailyCount = Number(row?.tenant_daily_count || 0);
  if (channelCount >= channelLimit) throw new ChannelQuotaError('AI Service Channel quota exceeded');
  if (tenantCount >= tenantLimit) throw new ChannelQuotaError('AI Service tenant quota exceeded');
  if (tenantDailyCount >= tenantDailyLimit) throw new ChannelQuotaError('AI Service tenant daily quota exceeded');
  const tokenRow = await queryOne<{ total_tokens: string }>(`SELECT COALESCE(SUM(COALESCE(m.input_tokens,0)+COALESCE(m.output_tokens,0)),0)::bigint AS total_tokens
    FROM ai_service_conversations c JOIN messages m ON m.session_id=c.runtime_session_id
    WHERE c.service_id=$1 AND c.channel_id=$2`,[input.serviceId,input.channelId]);
  if (Number(tokenRow?.total_tokens || 0) >= tokenLimit) throw new ChannelQuotaError('AI Service token limit exceeded');
}
