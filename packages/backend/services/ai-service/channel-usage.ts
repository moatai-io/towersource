/**
 * Owns AI Service Channel usage ledger writes for external serving controls.
 * Public API: recordChannelUsageEvent.
 */
import { execute, queryOne } from '../../db/pg-repo.js';
import type { AIServiceChannelExposure } from './channel-credential.js';
import { getChannelQuotaConfig } from './channel-quota.js';

export type ChannelUsageEventType = 'credential_issued' | 'conversation_created' | 'message_turn' | 'customer_request_recorded';

export interface ChannelUsageSummary {
  serviceId: string;
  channelId: string;
  windowSeconds: number;
  channelLimit: number;
  tenantLimit: number;
  tenantDailyLimit: number;
  tokenLimit: number;
  totalTokens: number;
  channelMessageTurns: number;
  channelDailyMessageTurns: number;
  credentialIssued: number;
  conversationsCreated: number;
  uniqueTenants: number;
  topTenant?: { tenantKey: string; messageTurns: number } | null;
  quota: {
    channelRemaining: number;
    channelRatio: number;
    status: 'ok' | 'near' | 'exceeded';
  };
}

export async function getChannelUsageSummary(input: { serviceId: string; channelId: string; windowSeconds?: number }): Promise<ChannelUsageSummary> {
  const configured = await getChannelQuotaConfig(input);
  const windowSeconds = input.windowSeconds || configured.windowSeconds;
  const { channelLimit, tenantLimit, tenantDailyLimit, tokenLimit } = configured;
  const row = await queryOne<{
    message_turns: string;
    channel_daily_message_turns: string;
    credential_issued: string;
    conversations_created: string;
    unique_tenants: string;
    top_tenant_key: string | null;
    top_tenant_message_turns: string | null;
  }>(
    `WITH recent AS (
       SELECT * FROM ai_service_channel_usage_events
        WHERE service_id=$1 AND channel_id=$2 AND created_at > NOW() - ($3::int * INTERVAL '1 second')
     ), tenant_counts AS (
       SELECT tenant_key, COUNT(*) FILTER (WHERE event_type='message_turn') AS message_turns
         FROM recent
        GROUP BY tenant_key
        ORDER BY message_turns DESC, tenant_key ASC
        LIMIT 1
     )
     SELECT
       COUNT(*) FILTER (WHERE event_type='message_turn') AS message_turns,
       (SELECT COUNT(*) FROM ai_service_channel_usage_events
         WHERE service_id=$1 AND channel_id=$2 AND event_type='message_turn' AND created_at > NOW() - INTERVAL '1 day') AS channel_daily_message_turns,
       COUNT(*) FILTER (WHERE event_type='credential_issued') AS credential_issued,
       COUNT(*) FILTER (WHERE event_type='conversation_created') AS conversations_created,
       COUNT(DISTINCT tenant_key) AS unique_tenants,
       (SELECT tenant_key FROM tenant_counts) AS top_tenant_key,
       (SELECT message_turns FROM tenant_counts) AS top_tenant_message_turns
      FROM recent`,
    [input.serviceId, input.channelId, windowSeconds],
  );
  const tokenRow = await queryOne<{ total_tokens: string }>(`SELECT COALESCE(SUM(COALESCE(m.input_tokens,0)+COALESCE(m.output_tokens,0)),0)::bigint AS total_tokens
    FROM ai_service_conversations c JOIN messages m ON m.session_id=c.runtime_session_id
    WHERE c.service_id=$1 AND c.channel_id=$2`,[input.serviceId,input.channelId]);
  const totalTokens = Number(tokenRow?.total_tokens || 0);
  const channelMessageTurns = Number(row?.message_turns || 0);
  const channelDailyMessageTurns = Number(row?.channel_daily_message_turns || 0);
  const channelRemaining = Math.max(0, channelLimit - channelMessageTurns);
  const channelRatio = Math.min(1, channelMessageTurns / channelLimit);
  const status = channelMessageTurns >= channelLimit ? 'exceeded' : channelRatio >= 0.8 ? 'near' : 'ok';
  return {
    serviceId: input.serviceId,
    channelId: input.channelId,
    windowSeconds,
    channelLimit,
    tenantLimit,
    tenantDailyLimit,
    tokenLimit,
    totalTokens,
    channelMessageTurns,
    channelDailyMessageTurns,
    credentialIssued: Number(row?.credential_issued || 0),
    conversationsCreated: Number(row?.conversations_created || 0),
    uniqueTenants: Number(row?.unique_tenants || 0),
    topTenant: row?.top_tenant_key ? { tenantKey: row.top_tenant_key, messageTurns: Number(row.top_tenant_message_turns || 0) } : null,
    quota: { channelRemaining, channelRatio, status },
  };
}

export async function recordChannelUsageEvent(input: {
  serviceId: string;
  channelId: string;
  conversationId?: string | null;
  tenantKey: string;
  userKey: string;
  eventType: ChannelUsageEventType;
  exposure?: AIServiceChannelExposure;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await execute(
    `INSERT INTO ai_service_channel_usage_events
       (service_id, channel_id, conversation_id, tenant_key, user_key, event_type, exposure, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      input.serviceId,
      input.channelId,
      input.conversationId || null,
      input.tenantKey,
      input.userKey,
      input.eventType,
      input.exposure || 'auth-required',
      JSON.stringify(input.metadata || {}),
    ],
  );
}
