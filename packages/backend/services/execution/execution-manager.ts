import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { transaction, withClient } from '../../db/pg-repo.js';
import type {
  AdmitExecutionInput,
  ExecutionRecord,
  ExecutionStatus,
  ExecutionTransitionInput,
} from './execution-types.js';

interface ExecutionDb {
  queryOne<T = any>(sql: string, params?: any[]): Promise<T | undefined>;
  execute(sql: string, params?: any[]): Promise<{ changes: number }>;
}

function mapExecutionRow(row: any): ExecutionRecord {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceId: row.source_id ?? null,
    sourceRunId: row.source_run_id ?? null,
    scopeKind: row.scope_kind,
    projectId: row.project_id ?? null,
    actorUserId: row.actor_user_id ?? null,
    status: row.status,
    adapterKind: row.adapter_kind,
    engine: row.engine ?? null,
    model: row.model ?? null,
    sessionId: row.session_id ?? null,
    executorRef: row.executor_ref ?? null,
    parentExecutionId: row.parent_execution_id ?? null,
    attempt: row.attempt,
    idempotencyKey: row.idempotency_key,
    inputJson: row.input_json || {},
    resultJson: row.result_json ?? null,
    summaryText: row.summary_text ?? null,
    errorJson: row.error_json ?? null,
    admittedAt: row.admitted_at ?? null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateScope(input: AdmitExecutionInput): void {
  const projectId = input.projectId ?? null;
  if (input.scopeKind === 'project' && !projectId) {
    throw new Error('project-scoped execution requires projectId');
  }
  if (input.scopeKind !== 'project' && projectId) {
    throw new Error(`${input.scopeKind}-scoped execution cannot reference projectId`);
  }
}

function sameAdmission(existing: ExecutionRecord, input: AdmitExecutionInput): boolean {
  return existing.sourceKind === input.sourceKind
    && existing.sourceId === (input.sourceId ?? null)
    && (existing.sourceRunId === (input.sourceRunId ?? null)
      // Automation admission links its Run after inserting the Execution.
      // A retry of the same occurrence still supplies null and must reuse that link.
      || (input.sourceKind === 'automation' && input.sourceRunId == null && existing.sourceRunId != null))
    && existing.scopeKind === input.scopeKind
    && existing.projectId === (input.projectId ?? null)
    && existing.actorUserId === (input.actorUserId ?? null)
    && existing.adapterKind === input.adapterKind;
}

export async function admitExecutionWithDb(
  db: ExecutionDb,
  input: AdmitExecutionInput,
): Promise<{ execution: ExecutionRecord; created: boolean }> {
  validateScope(input);
  const existingRow = await db.queryOne<any>(
    'SELECT * FROM executions WHERE idempotency_key = $1',
    [input.idempotencyKey],
  );
  if (existingRow) {
    const existing = mapExecutionRow(existingRow);
    if (!sameAdmission(existing, input)) {
      throw new Error('execution idempotency key conflicts with a different admission');
    }
    return { execution: existing, created: false };
  }

  const id = uuidv4();
  const row = await db.queryOne<any>(`
    INSERT INTO executions (
      id, source_kind, source_id, source_run_id,
      scope_kind, project_id, actor_user_id,
      status, adapter_kind, engine, model,
      parent_execution_id, attempt, idempotency_key, input_json,
      admitted_at
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7,
      'admitted', $8, $9, $10,
      $11, $12, $13, $14::jsonb,
      NOW()
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING *
  `, [
    id, input.sourceKind, input.sourceId ?? null, input.sourceRunId ?? null,
    input.scopeKind, input.projectId ?? null, input.actorUserId ?? null,
    input.adapterKind, input.engine ?? null, input.model ?? null,
    input.parentExecutionId ?? null, input.attempt ?? 1, input.idempotencyKey,
    JSON.stringify(input.inputJson || {}),
  ]);

  if (!row) {
    const raced = await db.queryOne<any>('SELECT * FROM executions WHERE idempotency_key = $1', [input.idempotencyKey]);
    if (!raced) throw new Error('execution admission conflict could not be resolved');
    const existing = mapExecutionRow(raced);
    if (!sameAdmission(existing, input)) {
      throw new Error('execution idempotency key conflicts with a different admission');
    }
    return { execution: existing, created: false };
  }

  await db.execute(`
    INSERT INTO execution_events (
      execution_id, event_type, from_status, to_status, actor_type, payload
    ) VALUES ($1, 'execution_admitted', NULL, 'admitted', 'system', $2::jsonb)
  `, [id, JSON.stringify({ sourceKind: input.sourceKind, adapterKind: input.adapterKind })]);

  return { execution: mapExecutionRow(row), created: true };
}

export async function admitExecution(input: AdmitExecutionInput): Promise<{ execution: ExecutionRecord; created: boolean }> {
  return transaction(async client => admitExecutionWithDb(withClient(client), input));
}

export async function transitionExecution(
  input: ExecutionTransitionInput,
  transact: typeof transaction = transaction,
): Promise<ExecutionRecord> {
  if (input.expectedStatuses.length === 0) throw new Error('expectedStatuses must not be empty');
  return transact(async (client: PoolClient) => {
    const db = withClient(client);
    const current = await db.queryOne<any>('SELECT * FROM executions WHERE id = $1 FOR UPDATE', [input.executionId]);
    if (!current) throw new Error('execution not found');
    if (!input.expectedStatuses.includes(current.status as ExecutionStatus)) {
      throw new Error(`execution transition conflict: expected ${input.expectedStatuses.join('|')}, found ${current.status}`);
    }

    const finished = ['succeeded', 'failed', 'cancelled', 'timed_out', 'uncertain'].includes(input.toStatus);
    const row = await db.queryOne<any>(`
      UPDATE executions SET
        status = $2,
        session_id = COALESCE($3, session_id),
        executor_ref = COALESCE($4, executor_ref),
        result_json = CASE WHEN $5::jsonb IS NULL THEN result_json ELSE $5::jsonb END,
        summary_text = COALESCE($6, summary_text),
        error_json = CASE WHEN $7::jsonb IS NULL THEN error_json ELSE $7::jsonb END,
        started_at = CASE WHEN $2 IN ('starting','running') THEN COALESCE(started_at, NOW()) ELSE started_at END,
        finished_at = CASE WHEN $8 THEN COALESCE(finished_at, NOW()) ELSE finished_at END,
        updated_at = NOW()
      WHERE id = $1 AND status = $9
      RETURNING *
    `, [
      input.executionId,
      input.toStatus,
      input.sessionId ?? null,
      input.executorRef ?? null,
      input.resultJson === undefined ? null : JSON.stringify(input.resultJson),
      input.summaryText ?? null,
      input.errorJson === undefined ? null : JSON.stringify(input.errorJson),
      finished,
      current.status,
    ]);
    if (!row) throw new Error('execution transition lost compare-and-set race');

    await db.execute(`
      INSERT INTO execution_events (
        execution_id, event_type, from_status, to_status, actor_type, actor_id, payload
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `, [
      input.executionId,
      input.eventType,
      current.status,
      input.toStatus,
      input.actorType || 'system',
      input.actorId ?? null,
      JSON.stringify(input.payload || {}),
    ]);
    return mapExecutionRow(row);
  });
}
