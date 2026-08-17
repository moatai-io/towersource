import { transaction, withClient } from '../../db/pg-repo.js';

export type ConfirmedStaleRuntimeCause = 'not_found' | 'not_running';

export type ConfirmedStaleRuntimeTransitionResult =
  | { transitioned: true }
  | { transitioned: false; reason: 'stale_box_state' };

export class ConfirmedStaleRuntimeTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfirmedStaleRuntimeTransitionError';
  }
}

/**
 * Atomically projects a confirmed-disappeared Runtime into PostgreSQL.
 * Docker cleanup must already be confirmed before this function is called.
 */
export async function transitionConfirmedStaleRuntime(input: {
  boxId: number;
  expectedStatus: 'running';
  expectedContainerId: string | null;
  cause: ConfirmedStaleRuntimeCause;
}): Promise<ConfirmedStaleRuntimeTransitionResult> {
  return transaction(async client => {
    const db = withClient(client);
    const box = await db.queryOne<{ id: number }>(
      `UPDATE project_runtime_boxes
          SET status='stopped',container_id=NULL,stopped_at=NOW(),updated_at=NOW(),
              last_error=$4
        WHERE id=$1 AND status=$2 AND container_id IS NOT DISTINCT FROM $3
        RETURNING id`,
      [input.boxId, input.expectedStatus, input.expectedContainerId,
        input.cause === 'not_found' ? 'reconcile: docker container not found' : 'reconcile: docker container not running'],
    );
    if (!box) return { transitioned: false, reason: 'stale_box_state' };

    await db.execute(
      `UPDATE runtime_box_services
          SET status=CASE WHEN status='expired' THEN 'expired' ELSE 'stopped' END,
              process_pid=NULL,stopped_at=COALESCE(stopped_at,NOW()),
              last_error=COALESCE(last_error,'reconcile: parent box is not running')
        WHERE box_id=$1 AND status IN ('pending','running','error')`,
      [input.boxId],
    );
    await db.execute(
      `UPDATE runtime_box_workbench_tool_projections
          SET status='unmounted',updated_at=NOW()
        WHERE box_id=$1 AND status <> 'recovery_required'`,
      [input.boxId],
    );
    return { transitioned: true };
  });
}
