import { execute, queryOne } from '../../db/pg-repo.js';
import type { ExecutionRecord } from './execution-types.js';
import type { LegacyTaskExecutionReceipt } from './adapters/legacy-task-execution-adapter.js';

export async function projectAutomationExecutionResult(params: {
  automationRunId: string;
  execution: ExecutionRecord;
  receipt: LegacyTaskExecutionReceipt;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  executionPath: 'execution_control_plane';
}): Promise<void> {
  const success = params.execution.status === 'succeeded';
  const status = success ? (params.receipt.resultJson?.automationOutcome === 'none' ? 'none' : 'success') : params.execution.status === 'timed_out' ? 'timeout' : 'failed';
  const updated = await execute(`
    UPDATE automation_runs SET
      status = $2,
      result_id = $3,
      error = $4,
      duration_ms = $5,
      started_at = $6,
      finished_at = $7,
      summary_text = $8,
      error_json = $9::jsonb,
      runner_kind = 'ai',
      runner_ref = $10
    WHERE id = $1 AND execution_id = $11
  `, [
    params.automationRunId,
    status,
    params.receipt.sessionId || params.receipt.taskId,
    success ? null : String(params.receipt.errorJson?.message || `Execution ended with status ${params.execution.status}`),
    params.durationMs,
    params.startedAt,
    params.finishedAt,
    params.receipt.summaryText,
    JSON.stringify({ ...(params.receipt.errorJson || {}), executionPath: params.executionPath, executionStatus: params.execution.status }),
    params.receipt.executorRef,
    params.execution.id,
  ]);
  if (updated.changes !== 1) {
    throw new Error(`Automation Run projection not written for execution ${params.execution.id}`);
  }
}

/** A terminal Execution alone does not prove its linked Run has been projected. */
export async function assertAutomationRunProjected(
  automationRunId: string,
  executionId: string,
  executionStatus: ExecutionRecord['status'],
): Promise<void> {
  const row = await queryOne<{ status: string; finished_at: Date | null; execution_status: string | null }>(`
    SELECT status, finished_at, error_json ->> 'executionStatus' AS execution_status
    FROM automation_runs WHERE id = $1 AND execution_id = $2
  `, [automationRunId, executionId]);
  const expectedStatus = executionStatus === 'succeeded' ? 'success' : executionStatus === 'timed_out' ? 'timeout' : 'failed';
  if (!row || (row.status !== expectedStatus && !(executionStatus === 'succeeded' && row.status === 'none')) || !row.finished_at || row.execution_status !== executionStatus) {
    throw new Error(`Automation Run projection incomplete for execution ${executionId}`);
  }
}
