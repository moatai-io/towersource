/**
 * Owns: missed-run policy for scheduled automation jobs.
 * Public API: decideDueRunAction(). See services/task/README.md.
 */
import type { Automation } from './automation-manager.js';

export type DueRunAction =
  | { action: 'run'; reason: string }
  | { action: 'skip'; reason: string; latenessMs: number };

export const CRON_CATCH_UP_GRACE_MS = 10 * 60 * 1000;

export function decideDueRunAction(automation: Pick<Automation, 'triggerType' | 'cronConfig' | 'nextRunAt'>, now: Date = new Date()): DueRunAction {
  if (!automation.nextRunAt) return { action: 'run', reason: 'no next_run_at; caller already selected due job' };

  const dueAt = new Date(automation.nextRunAt);
  const latenessMs = now.getTime() - dueAt.getTime();
  if (latenessMs <= CRON_CATCH_UP_GRACE_MS) {
    return { action: 'run', reason: 'within catch-up grace window' };
  }

  if (automation.triggerType === 'once') {
    return { action: 'run', reason: 'one-shot overdue runs once then consumes' };
  }

  if (automation.triggerType === 'cron' && automation.cronConfig?.type !== 'interval') {
    return { action: 'skip', reason: 'cron overdue beyond catch-up grace window', latenessMs };
  }

  // Interval jobs run once, then next_run_at is advanced from now. Never replay all missed intervals.
  return { action: 'run', reason: 'interval overdue runs once without replaying missed intervals' };
}
