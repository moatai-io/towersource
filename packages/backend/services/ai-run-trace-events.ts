/**
 * Owns: Private structural AI run trace events outside chat transcript storage.
 * Public API: recordAiRunTraceEvent.
 *
 * This service records lifecycle signals such as thinking start/end and live
 * progress phases without putting raw reasoning or hidden scratchpad commentary
 * into messages.content. Default consumers (chat history, search, share links,
 * and model rehydration) must not read this private trace table.
 */

import { execute, query, queryOne } from '../db/pg-repo.js';

export type AiRunTraceEventType =
  | 'thinking_start'
  | 'thinking_end'
  | 'thinking_signal'
  | 'commentary_signal'
  | 'progress_status'
  | 'provider_reasoning_metric'
  | 'trace_redaction_notice';

export interface AiRunTraceEventInput {
  sessionId: string;
  rootTurnId?: string | null;
  messageId?: string | null;
  projectId?: string | null;
  actorUserId?: number | null;
  engine: string;
  model?: string | null;
  eventType: AiRunTraceEventType;
  visibility?: 'private' | 'operator';
  /** Redacted structured metadata only. Do not include raw thinking/commentary text. */
  payload?: Record<string, unknown> | null;
}

export interface AiRunTraceSummary {
  sessionId: string;
  totalEvents: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  countsByType: Record<string, number>;
  countsByRootTurn: Array<{ rootTurnId: string | null; count: number; firstEventAt: string | null; lastEventAt: string | null }>;
  recentEvents: Array<{
    id: string;
    rootTurnId: string | null;
    messageId: string | null;
    engine: string;
    model: string | null;
    eventType: AiRunTraceEventType;
    visibility: 'private' | 'operator';
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
}

function scrubTracePayload(payload: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const input = payload && typeof payload === 'object' ? payload : {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    // Defense in depth: trace payloads should be structural. Block obvious raw
    // private-text slots even if a future caller accidentally supplies them.
    if (/^(raw|text|content|reasoning|thinking|commentary)$/i.test(key)) continue;
    if (/(_text|_content|prompt|completion)$/i.test(key)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 240);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
    else if (Array.isArray(value)) out[key] = value.slice(0, 20).map((item) => typeof item === 'string' ? item.slice(0, 120) : item);
    else if (typeof value === 'object') out[key] = value;
  }
  return out;
}

/** Persist one private run trace event. Best-effort callers may intentionally ignore failures. */
export async function recordAiRunTraceEvent(input: AiRunTraceEventInput): Promise<void> {
  const payload = scrubTracePayload(input.payload);
  await execute(
    `INSERT INTO ai_run_trace_events
       (session_id, root_turn_id, message_id, project_id, actor_user_id, engine, model, event_type, visibility, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      input.sessionId,
      input.rootTurnId || null,
      input.messageId || null,
      input.projectId || null,
      input.actorUserId ?? null,
      input.engine,
      input.model || null,
      input.eventType,
      input.visibility || 'private',
      JSON.stringify(payload),
    ],
  );
}

/** Return a redacted structural trace summary for privileged debugging. */
export async function getAiRunTraceSummary(sessionId: string, limit = 100): Promise<AiRunTraceSummary> {
  const cappedLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const totals = await queryOne<{ total_events: string; first_event_at: string | null; last_event_at: string | null }>(
    `SELECT COUNT(*)::text AS total_events,
            MIN(created_at)::text AS first_event_at,
            MAX(created_at)::text AS last_event_at
       FROM ai_run_trace_events
      WHERE session_id = $1`,
    [sessionId],
  );
  const byType = await query<{ event_type: string; count: string }>(
    `SELECT event_type, COUNT(*)::text AS count
       FROM ai_run_trace_events
      WHERE session_id = $1
      GROUP BY event_type
      ORDER BY count DESC, event_type ASC`,
    [sessionId],
  );
  const byRoot = await query<{ root_turn_id: string | null; count: string; first_event_at: string | null; last_event_at: string | null }>(
    `SELECT root_turn_id,
            COUNT(*)::text AS count,
            MIN(created_at)::text AS first_event_at,
            MAX(created_at)::text AS last_event_at
       FROM ai_run_trace_events
      WHERE session_id = $1
      GROUP BY root_turn_id
      ORDER BY MAX(created_at) DESC NULLS LAST
      LIMIT 50`,
    [sessionId],
  );
  const recent = await query<any>(
    `SELECT id, root_turn_id, message_id, engine, model, event_type, visibility, payload, created_at::text
       FROM ai_run_trace_events
      WHERE session_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [sessionId, cappedLimit],
  );
  return {
    sessionId,
    totalEvents: Number(totals?.total_events || 0),
    firstEventAt: totals?.first_event_at ?? null,
    lastEventAt: totals?.last_event_at ?? null,
    countsByType: Object.fromEntries(byType.map((row) => [row.event_type, Number(row.count || 0)])),
    countsByRootTurn: byRoot.map((row) => ({
      rootTurnId: row.root_turn_id,
      count: Number(row.count || 0),
      firstEventAt: row.first_event_at,
      lastEventAt: row.last_event_at,
    })),
    recentEvents: recent.map((row) => ({
      id: row.id,
      rootTurnId: row.root_turn_id ?? null,
      messageId: row.message_id ?? null,
      engine: row.engine,
      model: row.model ?? null,
      eventType: row.event_type,
      visibility: row.visibility,
      payload: scrubTracePayload(row.payload),
      createdAt: row.created_at,
    })),
  };
}
