import { queryOne } from '../../db/pg-repo.js';
import { transitionExecution } from './execution-manager.js';
import { TERMINAL_EXECUTION_STATUSES, type ExecutionRecord, type ExecutionStatus } from './execution-types.js';
import type { LegacyTaskExecutionReceipt } from './adapters/legacy-task-execution-adapter.js';

export type ExecutionReceipt = LegacyTaskExecutionReceipt;

const outcomeStatus: Record<ExecutionReceipt['outcome'], ExecutionStatus> = {
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  timed_out: 'timed_out',
  uncertain: 'uncertain',
};

interface CompletionReconcilerDependencies {
  getExecution(id: string): Promise<ExecutionRecord | undefined>;
  transition: typeof transitionExecution;
}

const defaultDependencies: CompletionReconcilerDependencies = {
  getExecution: async id => {
    const row = await queryOne<any>('SELECT * FROM executions WHERE id = $1', [id]);
    if (!row) return undefined;
    return {
      id: row.id, sourceKind: row.source_kind, sourceId: row.source_id ?? null,
      sourceRunId: row.source_run_id ?? null, scopeKind: row.scope_kind,
      projectId: row.project_id ?? null, actorUserId: row.actor_user_id ?? null,
      status: row.status, adapterKind: row.adapter_kind, engine: row.engine ?? null,
      model: row.model ?? null, sessionId: row.session_id ?? null,
      executorRef: row.executor_ref ?? null, parentExecutionId: row.parent_execution_id ?? null,
      attempt: row.attempt, idempotencyKey: row.idempotency_key,
      inputJson: row.input_json || {}, resultJson: row.result_json ?? null,
      summaryText: row.summary_text ?? null, errorJson: row.error_json ?? null,
      admittedAt: row.admitted_at ?? null, startedAt: row.started_at ?? null,
      finishedAt: row.finished_at ?? null, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  },
  transition: transitionExecution,
};

function sameTerminalEvidence(execution: ExecutionRecord, receipt: ExecutionReceipt, target: ExecutionStatus): boolean {
  return execution.status === target
    && execution.executorRef === receipt.executorRef
    && (execution.sessionId || null) === (receipt.sessionId || null);
}

export async function settleExecution(
  executionId: string,
  receipt: ExecutionReceipt,
  dependencies: CompletionReconcilerDependencies = defaultDependencies,
): Promise<{ execution: ExecutionRecord; settled: boolean }> {
  const current = await dependencies.getExecution(executionId);
  if (!current) throw new Error('execution not found');
  const target = outcomeStatus[receipt.outcome];

  if (TERMINAL_EXECUTION_STATUSES.has(current.status)) {
    if (sameTerminalEvidence(current, receipt, target)) return { execution: current, settled: false };
    throw new Error(`execution terminal conflict: ${current.status} cannot be replaced by ${target}`);
  }

  const execution = await dependencies.transition({
    executionId,
    expectedStatuses: [current.status],
    toStatus: target,
    eventType: `execution_${target}`,
    actorType: 'adapter',
    actorId: receipt.adapterKind,
    sessionId: receipt.sessionId,
    executorRef: receipt.executorRef,
    resultJson: receipt.resultJson,
    summaryText: receipt.summaryText,
    errorJson: receipt.errorJson,
    payload: { adapterKind: receipt.adapterKind, taskId: receipt.taskId },
  });
  return { execution, settled: true };
}
