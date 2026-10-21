// Owns: observe-only, user/agent/model-attributed Pi usage events.
// Public API: recordPiUsageEvent, getAiUsageBreakdown.

import { execute, query } from '../../db/pg-repo.js';
import type { TowerUsage } from '../../engines/types.js';

export type RecordPiUsageEventInput = {
  sessionId: string;
  rootTurnId: string;
  messageId?: string;
  usage: TowerUsage;
  requestedModel?: string;
  modelPolicyId?: string;
  modelPolicyRevision?: number;
  selectedPreset?: 'core' | 'lite';
  presetMappingRevision?: number;
};

export async function recordPiUsageEvent(input: RecordPiUsageEventInput): Promise<void> {
  const status = input.usage.stopReason === 'error' ? 'failed' : input.usage.stopReason === 'aborted' ? 'aborted' : 'completed';
  const cost = Number.isFinite(input.usage.costUsd) ? input.usage.costUsd! : null;
  try {
    await execute(`
    INSERT INTO ai_usage_events (
      actor_user_id, project_id, session_id, message_id, root_turn_id, parent_session_id,
      agent_id, agent_run_id, execution_kind, engine, model_policy_id, model_policy_revision,
      selected_preset, preset_mapping_revision,
      requested_model, router_model, provider_model, provider,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens,
      provider_cost_usd, cost_basis, router_request_id, provider_response_id, status, metadata
    )
    SELECT s.user_id, s.project_id, s.id, $3, $2, s.parent_session_id,
           aw.id, ar.id,
           CASE
             WHEN aw.id IS NOT NULL THEN 'persistent_agent'
             WHEN s.parent_session_id IS NOT NULL THEN 'spawned_session'
             WHEN s.kind = 'autonomous_run' THEN 'automation'
             WHEN s.label = 'channel_ai' THEN 'ai_service'
             ELSE 'interactive'
           END,
           'pi', $4, $5, $15, $16,
           $6, re.model,
           COALESCE(NULLIF(re.evidence->>'provider_model',''), NULLIF(re.evidence->>'response_model','')),
           COALESCE(NULLIF(re.evidence->>'provider',''), 'litellm'),
           $7, $8, $9, $10, $11, $12, $13,
           re.request_id, re.response_id, $14,
           jsonb_strip_nulls(jsonb_build_object(
             'router_terminal_type', re.terminal_type,
             'service_tier', re.service_tier,
             'router_observed_at', re.observed_at
           ))
      FROM sessions s
      LEFT JOIN LATERAL (
        SELECT e.* FROM agent_turn_router_evidence e
         WHERE e.root_turn_id = $2
         ORDER BY e.observed_at DESC LIMIT 1
      ) re ON TRUE
      LEFT JOIN agent_workers aw ON aw.backing_session_id = s.id
      LEFT JOIN LATERAL (
        SELECT r.* FROM agent_runs r
         WHERE r.worker_id = aw.id
         ORDER BY r.created_at DESC LIMIT 1
      ) ar ON TRUE
     WHERE s.id = $1
    ON CONFLICT (root_turn_id) DO NOTHING
  `, [
    input.sessionId, input.rootTurnId, input.messageId ?? null,
    input.modelPolicyId ?? null, input.modelPolicyRevision ?? null, input.requestedModel ?? null,
    input.usage.inputTokens || 0, input.usage.outputTokens || 0,
    input.usage.cacheReadTokens || 0, input.usage.cacheCreationTokens || 0,
    input.usage.reasoningTokens || 0, cost,
    cost === null ? 'unavailable' : 'rate_card_calculated', status,
    input.selectedPreset ?? null, input.presetMappingRevision ?? null,
    ]);
  } catch (error: any) {
    // Mixed-version rolling upgrades may start the new backend before migration
    // 220 is applied. Preserve the user turn and expose a bounded warning to the
    // caller rather than failing model execution.
    // During a rolling upgrade the new columns may not exist until migration 224.
    if (error?.code !== '42P01' && error?.code !== '42703') throw error;
  }
}

export async function getAiUsageBreakdown(params: { days: number; userId?: number }): Promise<any[]> {
  return query(`
    SELECT e.actor_user_id AS "userId", COALESCE(u.display_name,u.username,'알 수 없음') AS "userName",
           e.project_id AS "projectId", COALESCE(p.name,'프로젝트 없음') AS "projectName",
           e.agent_id AS "agentId", COALESCE(aw.name,p.name,'직접 세션') AS "agentName",
           e.model_policy_id AS "modelPolicyId", e.selected_preset AS "selectedPreset",
           e.preset_mapping_revision AS "presetMappingRevision", e.requested_model AS "requestedModel",
           e.router_model AS "routerModel", e.provider_model AS "providerModel", e.provider,
           COUNT(*)::int AS turns,
           SUM(e.input_tokens)::text AS "inputTokens", SUM(e.output_tokens)::text AS "outputTokens",
           SUM(e.cache_read_tokens)::text AS "cacheReadTokens",
           SUM(e.cache_creation_tokens)::text AS "cacheCreationTokens",
           SUM(e.reasoning_tokens)::text AS "reasoningTokens",
           SUM(e.provider_cost_usd)::text AS "costUsd",
           BOOL_AND(e.provider_model IS NOT NULL) AS "providerModelComplete"
      FROM ai_usage_events e
      LEFT JOIN users u ON u.id=e.actor_user_id
      LEFT JOIN projects p ON p.id=e.project_id
      LEFT JOIN agent_workers aw ON aw.id=e.agent_id
     WHERE e.occurred_at >= NOW() - ($1 || ' days')::interval
       AND ($2::int IS NULL OR e.actor_user_id=$2)
     GROUP BY e.actor_user_id,u.display_name,u.username,e.project_id,p.name,e.agent_id,aw.name,
              e.model_policy_id,e.selected_preset,e.preset_mapping_revision,e.requested_model,e.router_model,e.provider_model,e.provider
     ORDER BY SUM(e.provider_cost_usd) DESC NULLS LAST, SUM(e.input_tokens+e.output_tokens) DESC
  `, [String(Math.max(1, Math.min(params.days, 180))), params.userId ?? null]);
}
