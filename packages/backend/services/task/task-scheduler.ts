/**
 * Shared cron validation for the Automation Registry.
 *
 * Legacy tasks.schedule_* execution was retired in migration 160. Keep this
 * module only for API-boundary validation while callers migrate to a more
 * accurately named automation validation module.
 */
import type { ScheduleCron } from './task-manager.js';

/** Cron interval limits — backend tick is 30s so 1-minute is feasible. */
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 10080; // 1 week

/**
 * Validate a cron definition and throw on an out-of-range interval.
 *
 * @throws Error with a code-style message if interval minutes are outside
 * the supported [1, 10080] range.
 */
export function validateCron(cron: ScheduleCron): void {
  if (cron.type !== 'interval') return;
  const minutes = cron.minutes ?? (cron.hours ?? 1) * 60;
  if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES) {
    throw new Error(`CRON_INTERVAL_TOO_SHORT: minimum is ${MIN_INTERVAL_MINUTES} minute (got ${minutes})`);
  }
  if (minutes > MAX_INTERVAL_MINUTES) {
    throw new Error(`CRON_INTERVAL_TOO_LONG: maximum is ${MAX_INTERVAL_MINUTES} minutes / 1 week (got ${minutes})`);
  }
}
