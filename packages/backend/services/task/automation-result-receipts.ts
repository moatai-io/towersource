/** User-local acknowledgement; never mutates a Run, creates an alert or dispatches AI. */
import { queryOne } from '../../db/pg-repo.js';
import { canAccessAutomationJob } from './schedule-permissions.js';

export class AutomationReceiptError extends Error {
  constructor(public status: 403 | 404 | 409, message: string) { super(message); }
}
export async function automationResultReceiptsReady(): Promise<boolean> {
  const row = await queryOne<{ ready: boolean }>(`SELECT
    to_regclass('public.automation_result_receipts') IS NOT NULL
    AND (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'automation_result_receipts' AND column_name IN ('run_id','user_id','read_at','actioned_at')) = 4 AS ready`);
  return row?.ready === true;
}
export async function acknowledgeAutomationResult(input: {
  userId: number; role: string; projectId: string; runId: string; action: 'read' | 'actioned';
}) {
  if (!Number.isSafeInteger(input.userId) || input.userId < 1 || !['read', 'actioned'].includes(input.action)) {
    throw new AutomationReceiptError(403, 'invalid receipt actor or action');
  }
  const { getAutomation } = await import('./automation-manager.js');
  const run = await queryOne<{ automation_id: string }>('SELECT automation_id FROM automation_runs WHERE id = $1', [input.runId]);
  const automation = run ? await getAutomation(run.automation_id) : null;
  if (!automation || automation.projectId !== input.projectId) throw new AutomationReceiptError(404, 'result not found');
  const access = await canAccessAutomationJob(automation, input.userId, input.role, 'read');
  if (!access.allowed) throw new AutomationReceiptError(403, 'forbidden');
  if (!await automationResultReceiptsReady()) throw new AutomationReceiptError(409, 'personal result state is not available');
  // Re-check run/project identity in the write itself. User identity is always server-derived.
  const receipt = await queryOne<{ readAt: string; actionedAt: string | null }>(`
    INSERT INTO automation_result_receipts (run_id, user_id, read_at, actioned_at)
    SELECT r.id, $2, NOW(), CASE WHEN $4 = 'actioned' THEN NOW() ELSE NULL END
    FROM automation_runs r JOIN automations a ON a.id = r.automation_id
    WHERE r.id = $1 AND a.project_id = $3
    ON CONFLICT (run_id, user_id) DO UPDATE SET
      read_at = COALESCE(automation_result_receipts.read_at, EXCLUDED.read_at),
      actioned_at = COALESCE(automation_result_receipts.actioned_at, EXCLUDED.actioned_at)
    RETURNING read_at::text AS "readAt", actioned_at::text AS "actionedAt"
  `, [input.runId, input.userId, input.projectId, input.action]);
  if (!receipt) throw new AutomationReceiptError(404, 'result not found');
  return receipt;
}
