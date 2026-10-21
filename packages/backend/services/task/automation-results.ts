/** Read-only, project-scoped Automation Run results. Never interprets a legacy dispatch as completion. */
import type { AutomationRun } from '@tower/shared';
import { query, queryOne } from '../../db/pg-repo.js';
import { getAccessibleProjectIds } from '../pm/project-membership-manager.js';
import { canAccessAutomationJob } from './schedule-permissions.js';
import { canAccessSession } from '../pm/project-access.js';
import { automationResultSessionId, isUnverifiedAiSpawn } from './automation-result-reference.js';
import { getExecutionControlPlaneReadiness } from '../execution/execution-readiness.js';
import { automationResultReceiptsReady } from './automation-result-receipts.js';

export interface AutomationResultItem {
  automationId: string;
  automationName: string;
  projectId: string;
  run: AutomationRun;
  executionStatus?: string;
  outcomeUnverified?: true;
  sessionId?: string | null;
  receipt?: { readAt: string | null; actionedAt: string | null };
}

export class AutomationResultsAccessError extends Error {
  constructor(public readonly status: 401 | 403, message: string) { super(message); }
}

interface ResultRow {
  receipt_read_at?: string | null;
  receipt_actioned_at?: string | null;
  automation_id: string;
  automation_name: string;
  project_id: string;
  job_type: string;
  automation_user_id: number;
  id: string;
  status: string;
  mode: string;
  result_id: string | null;
  error: string | null;
  duration_ms: number | null;
  ran_at: string;
  trigger: AutomationRun['trigger'] | null;
  started_at: string | null;
  finished_at: string | null;
  stdout_text: string | null;
  stderr_text: string | null;
  summary_text: string | null;
  error_json: Record<string, unknown> | null;
  runner_kind: AutomationRun['runnerKind'];
  runner_ref: string | null;
  execution_status: string | null;
  execution_session_id: string | null;
}

type RunEvidence = {
  mode: string; resultId: string | null; runnerKind: string | null; runnerRef: string | null;
  error: string | null; stdoutText: string | null; stderrText: string | null;
  summaryText: string | null; errorJson: Record<string, unknown> | null;
};

/** Caller must first authorize Automation read. Reusable by feed and individual run routes.
 * Returns a copy, preserving status/timestamps, plus only an ACL-approved session link.
 * Optional executionSessionId must come from a persisted, scoped execution join.
 */
export async function sanitizeAutomationRunEvidence<T extends RunEvidence>(
  run: T,
  automation: { mode: string; jobType?: string; projectId?: string | null },
  userId: number,
  role: string,
  executionSessionId?: string | null,
): Promise<{ run: T; sessionId: string | null }> {
  const redact = (): { run: T; sessionId: null } => ({
    run: { ...run, resultId: null, error: null, stdoutText: null, stderrText: null,
      summaryText: null, errorJson: null, runnerRef: null }, sessionId: null,
  });
  if (!Number.isInteger(userId) || userId < 1) return redact();
  let candidate = executionSessionId || automationResultSessionId(run, { ...automation, mode: run.mode });
  try {
    if (!candidate && (run.runnerKind === 'ai' || run.runnerKind === null)
      && automation.jobType === 'ai_prompt' && run.mode === 'spawn') {
      // resultId is polymorphic. Resolve task references through persisted tasks,
      // never interpret a task ID itself as a Session. Do not cross Project boundaries.
      const taskId = run.runnerRef?.startsWith('task:') ? run.runnerRef.slice(5)
        : run.runnerRef?.startsWith('completed-task:') ? run.runnerRef.slice(15) : run.resultId;
      if (taskId) {
        const task = await queryOne<{ session_id: string | null }>(
          'SELECT session_id FROM tasks WHERE id = $1 AND project_id IS NOT DISTINCT FROM $2::text',
          [taskId, automation.projectId ?? null],
        );
        candidate = task?.session_id || null;
      }
    }
    if (candidate) {
      if (!(await canAccessSession(candidate, userId, role)).allowed) return redact();
      return { run: { ...run }, sessionId: candidate };
    }
  } catch { return redact(); }
  return { run: { ...run }, sessionId: null };
}

/** Project id is mandatory: no unbounded/global feed and no projectless runs. */
export async function listAutomationResults(input: {
  userId: number;
  role: string;
  projectId: string;
  limit: number;
}): Promise<{ items: AutomationResultItem[]; receiptStateAvailable: boolean }> {
  if (!Number.isInteger(input.userId) || input.userId < 1) throw new AutomationResultsAccessError(401, 'unauthorized');
  const visible = await getAccessibleProjectIds(input.userId, input.role);
  if (visible !== null && !visible.includes(input.projectId)) {
    throw new AutomationResultsAccessError(403, 'forbidden');
  }
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new RangeError('limit must be between 1 and 100');

  // The optional Execution schema must not prevent a pre-221 server from reading legacy history.
  const { ready } = await getExecutionControlPlaneReadiness();
  const receiptStateAvailable = await automationResultReceiptsReady();
  const receiptColumns = receiptStateAvailable
    ? 'rr.read_at::text AS receipt_read_at, rr.actioned_at::text AS receipt_actioned_at'
    : 'NULL::text AS receipt_read_at, NULL::text AS receipt_actioned_at';
  const receiptJoin = receiptStateAvailable
    ? 'LEFT JOIN automation_result_receipts rr ON rr.run_id = r.id AND rr.user_id = $3' : '';
  const executionColumns = ready
    ? 'e.status AS execution_status, e.session_id AS execution_session_id'
    : 'NULL::text AS execution_status, NULL::text AS execution_session_id';
  const executionJoin = ready ? `LEFT JOIN executions e ON e.id = r.execution_id
      AND e.source_kind = 'automation' AND e.source_id = a.id
      AND e.scope_kind = 'project' AND e.project_id = a.project_id` : '';

  // Scope in SQL BEFORE LIMIT; never fetch global latest runs and filter afterwards.
  // Only a linked execution from this same automation/project contributes status or session.
  const rows = await query<ResultRow>(`
    SELECT r.id, r.automation_id, a.name AS automation_name, a.project_id, a.job_type, a.user_id AS automation_user_id,
      r.status, r.mode, r.result_id, r.error, r.duration_ms, r.ran_at,
      r.trigger, r.started_at, r.finished_at, r.stdout_text, r.stderr_text,
      r.summary_text, r.error_json, r.runner_kind, r.runner_ref,
      ${executionColumns}, ${receiptColumns}
    FROM automation_runs r
    JOIN automations a ON a.id = r.automation_id
    ${executionJoin}
    ${receiptJoin}
    WHERE a.project_id = $1
    ORDER BY r.ran_at DESC, r.id DESC
    LIMIT $2
  `, receiptStateAvailable ? [input.projectId, input.limit, input.userId] : [input.projectId, input.limit]);

  const items: AutomationResultItem[] = [];
  for (const row of rows) {
    // Keep the result feed at least as strict as /automations/:id/runs.
    // A stale membership cache must not turn a project-scoped query into access.
    const jobAccess = await canAccessAutomationJob({ userId: row.automation_user_id, projectId: row.project_id }, input.userId, input.role, 'read');
    if (!jobAccess.allowed) continue;
    const persistedRun: AutomationRun = {
      id: row.id, automationId: row.automation_id, status: row.status, mode: row.mode,
      resultId: row.result_id, error: row.error, durationMs: row.duration_ms, ranAt: row.ran_at,
      trigger: row.trigger || 'schedule', startedAt: row.started_at, finishedAt: row.finished_at,
      stdoutText: row.stdout_text, stderrText: row.stderr_text, summaryText: row.summary_text,
      errorJson: row.error_json, runnerKind: row.runner_kind, runnerRef: row.runner_ref,
    };
    const { run, sessionId } = await sanitizeAutomationRunEvidence(persistedRun,
      { mode: row.mode, jobType: row.job_type, projectId: row.project_id },
      input.userId, input.role, row.execution_session_id);
    items.push({
      automationId: row.automation_id,
      automationName: row.automation_name,
      projectId: row.project_id,
      run,
      executionStatus: row.execution_status || undefined,
      outcomeUnverified: !row.execution_status && isUnverifiedAiSpawn(persistedRun, { jobType: row.job_type })
        ? true : undefined,
      sessionId,
      receipt: receiptStateAvailable ? { readAt: row.receipt_read_at || null, actionedAt: row.receipt_actioned_at || null } : undefined,
    });
  }
  return { items, receiptStateAvailable };
}
