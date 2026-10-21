import { queryOne } from '../../db/pg-repo.js';
import { transitionExecution } from './execution-manager.js';
import { TERMINAL_EXECUTION_STATUSES, type ExecutionRecord } from './execution-types.js';

export async function recoverExecutionFailure(params: {
  executionId: string;
  phase: 'starting' | 'adapter' | 'reconcile' | 'projection';
  error: unknown;
  executorRef?: string | null;
  sessionId?: string | null;
}, dependencies: {
  getExecution?: (id: string) => Promise<ExecutionRecord | undefined>;
  transition?: typeof transitionExecution;
} = {}): Promise<ExecutionRecord> {
  const getExecution = dependencies.getExecution || (async id => {
    const row = await queryOne<any>('SELECT * FROM executions WHERE id = $1', [id]);
    if (!row) return undefined;
    return {
      id: row.id, sourceKind: row.source_kind, sourceId: row.source_id ?? null, sourceRunId: row.source_run_id ?? null,
      scopeKind: row.scope_kind, projectId: row.project_id ?? null, actorUserId: row.actor_user_id ?? null,
      status: row.status, adapterKind: row.adapter_kind, engine: row.engine ?? null, model: row.model ?? null,
      sessionId: row.session_id ?? null, executorRef: row.executor_ref ?? null, parentExecutionId: row.parent_execution_id ?? null,
      attempt: row.attempt, idempotencyKey: row.idempotency_key, inputJson: row.input_json || {}, resultJson: row.result_json ?? null,
      summaryText: row.summary_text ?? null, errorJson: row.error_json ?? null, admittedAt: row.admitted_at ?? null,
      startedAt: row.started_at ?? null, finishedAt: row.finished_at ?? null, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  });
  const transition = dependencies.transition || transitionExecution;
  const current = await getExecution(params.executionId);
  if (!current) throw new Error('execution not found during failure recovery');
  if (TERMINAL_EXECUTION_STATUSES.has(current.status)) return current;

  const message = params.error instanceof Error ? params.error.message : String(params.error);
  const uncertain = params.phase !== 'starting';
  return transition({
    executionId: params.executionId,
    expectedStatuses: [current.status],
    toStatus: uncertain ? 'uncertain' : 'failed',
    eventType: uncertain ? 'execution_uncertain' : 'execution_failed',
    actorType: 'system',
    sessionId: params.sessionId || null,
    executorRef: params.executorRef || null,
    summaryText: `Execution failed during ${params.phase}`,
    errorJson: { message, phase: params.phase, retryable: false },
    payload: { phase: params.phase, recovered: true },
  });
}
