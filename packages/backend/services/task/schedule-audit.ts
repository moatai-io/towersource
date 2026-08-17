/**
 * Owns: read-only diagnostics for schedule/task/automation migration.
 * Public API: auditScheduleState(). See services/task/README.md.
 */
import { query, queryOne } from '../../db/pg-repo.js';

export interface ScheduleAuditState {
  tasksScheduled: number;
  schedules: number;
  automations: number;
  automationScheduled: number;
  automationByType: Record<string, number>;
}

export async function auditScheduleState(): Promise<ScheduleAuditState> {
  const row = await queryOne<any>(`
    SELECT
      (SELECT COUNT(*)::int FROM tasks WHERE scheduled_at IS NOT NULL OR schedule_enabled = 1) AS tasks_scheduled,
      (SELECT COUNT(*)::int FROM schedules) AS schedules,
      (SELECT COUNT(*)::int FROM automations WHERE status != 'archived') AS automations,
      (SELECT COUNT(*)::int FROM automations WHERE status != 'archived' AND trigger_type IN ('cron', 'once')) AS automation_scheduled
  `);

  const byTypeRows = await query<{ job_type: string; cnt: number }>(`
    SELECT COALESCE(job_type, 'legacy_ai') AS job_type, COUNT(*)::int AS cnt
    FROM automations
    WHERE status != 'archived'
    GROUP BY COALESCE(job_type, 'legacy_ai')
  `);

  return {
    tasksScheduled: row?.tasks_scheduled ?? 0,
    schedules: row?.schedules ?? 0,
    automations: row?.automations ?? 0,
    automationScheduled: row?.automation_scheduled ?? 0,
    automationByType: Object.fromEntries(byTypeRows.map((r) => [r.job_type, r.cnt])),
  };
}
