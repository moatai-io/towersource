import { execute, query } from '../../db/pg-repo.js';
import { TERMINAL_EXECUTION_STATUSES, type ExecutionStatus } from './execution-types.js';

export interface RecoverableAutomationProjection {
  automationRunId: string;
  executionId: string;
  executionStatus: ExecutionStatus;
  sessionId: string | null;
  executorRef: string | null;
  resultJson: Record<string, unknown>;
  summaryText: string | null;
  errorJson: Record<string, unknown> | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export async function listRecoverableAutomationProjections(limit = 100): Promise<RecoverableAutomationProjection[]> {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
  const rows = await query<any>(`
    SELECT
      ar.id AS automation_run_id,
      e.id AS execution_id,
      e.status AS execution_status,
      e.session_id,
      e.executor_ref,
      e.result_json,
      e.summary_text,
      e.error_json,
      e.started_at,
      e.finished_at
    FROM automation_runs ar
    JOIN executions e ON e.id = ar.execution_id
    WHERE e.status IN ('succeeded','failed','cancelled','timed_out','uncertain')
      AND (
        ar.status IN ('queued','admitted','starting','running')
        OR ar.finished_at IS NULL
        OR (ar.error_json ->> 'executionStatus') IS DISTINCT FROM e.status
      )
    ORDER BY e.finished_at ASC NULLS LAST, e.created_at ASC
    LIMIT $1
  `, [boundedLimit]);
  return rows.map(row => ({
    automationRunId: row.automation_run_id,
    executionId: row.execution_id,
    executionStatus: row.execution_status,
    sessionId: row.session_id ?? null,
    executorRef: row.executor_ref ?? null,
    resultJson: row.result_json || {},
    summaryText: row.summary_text ?? null,
    errorJson: row.error_json ?? null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
  }));
}

export async function recoverAutomationExecutionProjection(
  candidate: RecoverableAutomationProjection,
): Promise<{ recovered: boolean; reason: 'updated' | 'not_terminal' | 'already_projected' }> {
  if (!TERMINAL_EXECUTION_STATUSES.has(candidate.executionStatus)) {
    return { recovered: false, reason: 'not_terminal' };
  }
  const success = candidate.executionStatus === 'succeeded';
  const status = success ? 'success' : candidate.executionStatus === 'timed_out' ? 'timeout' : 'failed';
  const taskId = typeof candidate.resultJson.taskId === 'string' ? candidate.resultJson.taskId : null;
  const resultId = candidate.sessionId || taskId;
  const errorJson = {
    ...(candidate.errorJson || {}),
    executionPath: 'execution_control_plane',
    executionStatus: candidate.executionStatus,
    projectionRecovered: true,
  };
  const result = await execute(`
    UPDATE automation_runs SET
      status = $3,
      result_id = COALESCE(result_id, $4),
      error = $5,
      duration_ms = COALESCE(duration_ms,
        CASE WHEN $6::timestamptz IS NOT NULL AND $7::timestamptz IS NOT NULL
          THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($7::timestamptz - $6::timestamptz)) * 1000)::int)
          ELSE NULL END),
      started_at = COALESCE(started_at, $6::timestamptz),
      finished_at = COALESCE(finished_at, $7::timestamptz, NOW()),
      summary_text = COALESCE(summary_text, $8),
      error_json = $9::jsonb,
      runner_kind = COALESCE(NULLIF(runner_kind, 'system'), 'ai'),
      runner_ref = COALESCE(runner_ref, $10)
    WHERE id = $1
      AND execution_id = $2
      AND (
        status IN ('queued','admitted','starting','running')
        OR finished_at IS NULL
        OR (error_json ->> 'executionStatus') IS DISTINCT FROM $11
      )
  `, [
    candidate.automationRunId,
    candidate.executionId,
    status,
    resultId,
    success ? null : String(candidate.errorJson?.message || `Execution ended with status ${candidate.executionStatus}`),
    candidate.startedAt,
    candidate.finishedAt,
    candidate.summaryText,
    JSON.stringify(errorJson),
    candidate.executorRef,
    candidate.executionStatus,
  ]);
  return result.changes === 1
    ? { recovered: true, reason: 'updated' }
    : { recovered: false, reason: 'already_projected' };
}

export async function recoverAutomationExecutionProjections(limit = 100): Promise<{
  examined: number;
  recovered: number;
  skipped: number;
}> {
  const candidates = await listRecoverableAutomationProjections(limit);
  let recovered = 0;
  for (const candidate of candidates) {
    const result = await recoverAutomationExecutionProjection(candidate);
    if (result.recovered) recovered += 1;
  }
  return { examined: candidates.length, recovered, skipped: candidates.length - recovered };
}
