// Owns: durable at-most-once execution records for potentially side-effectful Pi tools.
// Public API: beginSideEffectExecution, finishSideEffectExecution, failSideEffectExecution. See README.md.

import crypto from 'node:crypto';
import { transaction, withClient } from '../../db/pg-repo.js';

export type SideEffectExecutionDisposition =
  | { kind: 'execute'; executionId: string; ownerToken: string }
  | { kind: 'reuse'; result: unknown }
  | { kind: 'block'; status: 'running' | 'uncertain'; message: string };

/** Stable semantic identity used only while recovering; normal intentional repeats remain distinct by tool-call id. */
export function buildSideEffectSemanticHash(toolName: string, params: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify({ toolName, params })).digest('hex');
}

/**
 * Claim a side-effect execution. During recovery, a prior semantic match is
 * reused even if the model generated a new tool-call id. A stale running row
 * becomes uncertain and is never auto-retried.
 */
export async function beginSideEffectExecution(params: {
  rootTurnId: string;
  sessionId: string;
  toolName: string;
  toolCallId: string;
  semanticHash: string;
  recovering: boolean;
  leaseSeconds?: number;
}, transact: typeof transaction = transaction): Promise<SideEffectExecutionDisposition> {
  const leaseSeconds = Math.max(15, Math.min(params.leaseSeconds ?? 300, 1800));
  const operationId = `${params.rootTurnId}:${params.toolName}:${params.toolCallId}`;

  return transact(async client => {
    const db = withClient(client);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `side-effect:${params.rootTurnId}:${params.toolName}:${params.semanticHash}`,
    ]);

    const exact = await db.queryOne<any>(
      `SELECT * FROM side_effect_executions
        WHERE root_turn_id = $1 AND operation_id = $2
        LIMIT 1`,
      [params.rootTurnId, operationId],
    );
    const prior = exact ?? (params.recovering
      ? await db.queryOne<any>(
          `SELECT * FROM side_effect_executions
            WHERE root_turn_id = $1 AND tool_name = $2 AND semantic_hash = $3
            ORDER BY created_at DESC
            LIMIT 1`,
          [params.rootTurnId, params.toolName, params.semanticHash],
        )
      : undefined);

    if (prior?.status === 'succeeded') {
      return { kind: 'reuse', result: prior.result_json };
    }
    if (prior?.status === 'uncertain') {
      return {
        kind: 'block',
        status: 'uncertain',
        message: `Previous ${params.toolName} execution has an uncertain outcome; automatic repetition was blocked.`,
      };
    }
    if (prior?.status === 'running') {
      if (new Date(prior.lease_until).getTime() <= Date.now()) {
        await db.execute(
          `UPDATE side_effect_executions
              SET status = 'uncertain', updated_at = NOW(), error = COALESCE(error, 'lease expired before a durable result')
            WHERE id = $1 AND status = 'running'`,
          [prior.id],
        );
        return {
          kind: 'block',
          status: 'uncertain',
          message: `Previous ${params.toolName} execution may have completed before disconnect; automatic repetition was blocked.`,
        };
      }
      return {
        kind: 'block',
        status: 'running',
        message: `The same ${params.toolName} operation is already running; duplicate execution was blocked.`,
      };
    }

    const executionId = crypto.randomUUID();
    const ownerToken = crypto.randomUUID();
    await db.execute(
      `INSERT INTO side_effect_executions
        (id, root_turn_id, session_id, tool_name, tool_call_id, operation_id, semantic_hash,
         status, owner_token, lease_until, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8,
               NOW() + ($9::int * INTERVAL '1 second'), NOW(), NOW())`,
      [executionId, params.rootTurnId, params.sessionId, params.toolName, params.toolCallId,
       operationId, params.semanticHash, ownerToken, leaseSeconds],
    );
    return { kind: 'execute', executionId, ownerToken };
  });
}

/** Persist a successful result so continuation/restart can return it without re-execution. */
export async function finishSideEffectExecution(params: {
  executionId: string;
  ownerToken: string;
  result: unknown;
}, transact: typeof transaction = transaction): Promise<boolean> {
  return transact(async client => {
    const db = withClient(client);
    const changed = await db.execute(
      `UPDATE side_effect_executions
          SET status = 'succeeded', result_json = $3::jsonb, lease_until = NULL,
              completed_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND owner_token = $2 AND status = 'running'`,
      [params.executionId, params.ownerToken, JSON.stringify(params.result ?? null)],
    );
    return changed.changes === 1;
  });
}

/** Tool throws are uncertain because the external action may have succeeded before transport failed. */
export async function failSideEffectExecution(params: {
  executionId: string;
  ownerToken: string;
  error: string;
}, transact: typeof transaction = transaction): Promise<boolean> {
  return transact(async client => {
    const db = withClient(client);
    const changed = await db.execute(
      `UPDATE side_effect_executions
          SET status = 'uncertain', error = $3, lease_until = NULL,
              completed_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND owner_token = $2 AND status = 'running'`,
      [params.executionId, params.ownerToken, params.error.slice(0, 2000)],
    );
    return changed.changes === 1;
  });
}
