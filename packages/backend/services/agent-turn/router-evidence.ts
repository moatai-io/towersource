// Owns: diagnostic Router/provider evidence attached to a durable root turn.
// Public API: recordAgentTurnRouterEvidence, decideRouterReconciliation. See README.md.

import { execute, queryOne } from '../../db/pg-repo.js';

export type RouterTerminalType =
  | 'response.completed'
  | 'response.failed'
  | 'response.incomplete'
  | 'transport_closed_without_terminal'
  | 'client_cancelled';

export type AgentTurnRouterEvidence = {
  rootTurnId: string;
  sessionId: string;
  towerRunId: string;
  attempt?: number;
  requestId?: string;
  responseId?: string;
  terminalType?: RouterTerminalType;
  httpStatus?: number;
  model?: string;
  serviceTier?: string;
  durationMs?: number;
  errorCode?: string;
  evidence?: Record<string, unknown>;
};

/** Persist secret-free Router evidence without changing durable turn state. */
export async function recordAgentTurnRouterEvidence(input: AgentTurnRouterEvidence): Promise<void> {
  await queryOne(
    `INSERT INTO agent_turn_router_evidence (
       root_turn_id, session_id, tower_run_id, attempt, request_id, response_id,
       terminal_type, http_status, model, service_tier, duration_ms, error_code, evidence
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
     ON CONFLICT (root_turn_id, tower_run_id, request_id, terminal_type)
     DO UPDATE SET response_id = COALESCE(EXCLUDED.response_id, agent_turn_router_evidence.response_id),
                   http_status = COALESCE(EXCLUDED.http_status, agent_turn_router_evidence.http_status),
                   model = COALESCE(EXCLUDED.model, agent_turn_router_evidence.model),
                   service_tier = COALESCE(EXCLUDED.service_tier, agent_turn_router_evidence.service_tier),
                   duration_ms = COALESCE(EXCLUDED.duration_ms, agent_turn_router_evidence.duration_ms),
                   error_code = COALESCE(EXCLUDED.error_code, agent_turn_router_evidence.error_code),
                   evidence = agent_turn_router_evidence.evidence || EXCLUDED.evidence,
                   observed_at = NOW()
     RETURNING id`,
    [
      input.rootTurnId,
      input.sessionId,
      input.towerRunId,
      input.attempt ?? 0,
      input.requestId ?? null,
      input.responseId ?? null,
      input.terminalType ?? null,
      input.httpStatus ?? null,
      input.model ?? null,
      input.serviceTier ?? null,
      input.durationMs ?? null,
      input.errorCode ?? null,
      JSON.stringify(input.evidence ?? {}),
    ],
  );

  // Router evidence is captured from a cloned stream and can finish just after
  // Tower emits turn_done. Reconcile the append-only usage row in either order
  // without treating router success as execution authority.
  await execute(
    `UPDATE ai_usage_events
        SET router_model = COALESCE(router_model, $2),
            provider_model = COALESCE(provider_model, NULLIF($3, '')),
            provider = COALESCE(provider, NULLIF($4, '')),
            router_request_id = COALESCE(router_request_id, $5),
            provider_response_id = COALESCE(provider_response_id, $6),
            metadata = metadata || jsonb_strip_nulls(jsonb_build_object(
              'router_terminal_type', $7::text,
              'service_tier', $8::text,
              'router_observed_at', NOW()
            ))
      WHERE root_turn_id = $1`,
    [
      input.rootTurnId,
      input.model ?? null,
      String(input.evidence?.provider_model ?? input.evidence?.response_model ?? ''),
      String(input.evidence?.provider ?? ''),
      input.requestId ?? null,
      input.responseId ?? null,
      input.terminalType ?? null,
      input.serviceTier ?? null,
    ],
  ).catch((error: any) => {
    // Migration skew during rolling upgrades must not break router evidence.
    if (error?.code !== '42P01') throw error;
  });
}

export type RouterReconciliationDecision =
  | { action: 'complete'; reason: 'durable_assistant_and_router_completed' }
  | { action: 'needs_reconciliation'; reason: 'router_completed_without_durable_assistant' }
  | { action: 'retry_eligible'; reason: 'router_failed_without_durable_assistant' }
  | { action: 'observe'; reason: 'router_terminal_absent_or_non_authoritative' };

/**
 * Router terminal evidence is diagnostic only. Completion always requires the
 * Tower durable assistant row; Router success alone must never authorize replay
 * or completion.
 */
export function decideRouterReconciliation(params: {
  terminalType?: RouterTerminalType;
  durableAssistant: boolean;
}): RouterReconciliationDecision {
  if (params.terminalType === 'response.completed') {
    return params.durableAssistant
      ? { action: 'complete', reason: 'durable_assistant_and_router_completed' }
      : { action: 'needs_reconciliation', reason: 'router_completed_without_durable_assistant' };
  }
  if ((params.terminalType === 'response.failed' || params.terminalType === 'response.incomplete') && !params.durableAssistant) {
    return { action: 'retry_eligible', reason: 'router_failed_without_durable_assistant' };
  }
  return { action: 'observe', reason: 'router_terminal_absent_or_non_authoritative' };
}
