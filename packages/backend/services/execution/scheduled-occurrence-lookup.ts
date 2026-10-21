import { queryOne } from '../../db/pg-repo.js';

/** Read-only lookup before missed-run skip; never admits or starts an execution. */
export async function hasScheduledAutomationExecution(
  automationId: string,
  dueAt: string,
  query: typeof queryOne = queryOne,
): Promise<boolean> {
  const idempotencyKey = `automation:${automationId}:schedule:${new Date(dueAt).toISOString()}`;
  const row = await query<{ source_kind: string; source_id: string | null }>(
    'SELECT source_kind, source_id FROM executions WHERE idempotency_key = $1',
    [idempotencyKey],
  );
  if (!row) return false;
  if (row.source_kind !== 'automation' || row.source_id !== automationId) {
    throw new Error('scheduled occurrence identity conflicts with a different execution');
  }
  return true;
}
