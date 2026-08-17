/**
 * Task Scheduler — checks for due scheduled tasks every 30s and spawns them.
 *
 * Design: see ~/workspace/decisions/2026-03-03-kanban-scheduled-tasks-design.md
 */
import { query } from '../../db/pg-repo.js';
import { getTask, updateTask, type TaskMeta, type ScheduleCron } from './task-manager.js';
import { spawnTask } from './task-runner.js';

const SCHEDULER_INTERVAL = 30_000; // 30 seconds
const MAX_CONCURRENT_TASKS = 10;   // mirrors task-runner.ts

type BroadcastFn = (type: string, data: any) => void;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

/** Cron interval limits (2026-05-16) — backend tick is 30s so 1-min is feasible. */
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 10080; // 1 week

/**
 * Validate a ScheduleCron and throw on out-of-range interval.
 * Called by API boundaries (POST/PATCH /api/tasks, /api/schedules) before persisting.
 *
 * @throws Error with code-style message if interval minutes are out of [1, 10080].
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

/**
 * Calculate the next run time from a ScheduleCron pattern.
 * All calculations in local time (server timezone).
 *
 * Interval mode: `minutes` takes precedence over `hours` when both are set,
 * mirroring frontend behavior. Defaults to 1 hour if neither is set.
 */
export function calculateNextRun(cron: ScheduleCron, from: Date = new Date()): Date {
  const next = new Date(from);

  switch (cron.type) {
    case 'daily': {
      next.setHours(cron.hour ?? 9, cron.minute ?? 0, 0, 0);
      if (next <= from) next.setDate(next.getDate() + 1);
      return next;
    }

    case 'weekdays': {
      next.setHours(cron.hour ?? 9, cron.minute ?? 0, 0, 0);
      if (next <= from) next.setDate(next.getDate() + 1);
      // Skip weekends (0=Sun, 6=Sat)
      while (next.getDay() === 0 || next.getDay() === 6) {
        next.setDate(next.getDate() + 1);
      }
      return next;
    }

    case 'weekly': {
      const targetDay = cron.day ?? 1; // default Monday
      next.setHours(cron.hour ?? 9, cron.minute ?? 0, 0, 0);
      // Advance to next occurrence of target day
      let daysUntil = targetDay - next.getDay();
      if (daysUntil < 0) daysUntil += 7;
      if (daysUntil === 0 && next <= from) daysUntil = 7;
      next.setDate(next.getDate() + daysUntil);
      return next;
    }

    case 'interval': {
      // minutes takes precedence (added 2026-05-16). hours kept for backward compat.
      const minutes = cron.minutes ?? (cron.hours ?? 1) * 60;
      const intervalMs = minutes * 60 * 1000;
      return new Date(from.getTime() + intervalMs);
    }

    default:
      // Fallback: 1 hour from now
      return new Date(from.getTime() + 3600_000);
  }
}

/**
 * Single tick — find due tasks and spawn them.
 */
async function tick(broadcastFn: BroadcastFn, userId?: number, userRole?: string, allowedPath?: string) {
  try {
    const now = new Date().toISOString();
    const dueTasks = await query<any>(`
      SELECT * FROM tasks
      WHERE status = 'todo'
        AND schedule_enabled = 1
        AND scheduled_at IS NOT NULL
        AND scheduled_at <= $1
        AND (archived IS NULL OR archived = 0)
      ORDER BY scheduled_at ASC
    `, [now]);

    if (dueTasks.length === 0) return;

    console.log(`[scheduler] Found ${dueTasks.length} due task(s)`);

    for (const row of dueTasks) {
      const taskId = row.id;
      try {
        // Disable schedule before spawn to prevent re-trigger on next tick.
        // For one-time schedules, clear everything.
        // For recurring, the reset happens in task-runner after completion.
        if (!row.schedule_cron) {
          // One-time: clear schedule entirely
          await updateTask(taskId, {
            scheduledAt: null as any,
            scheduleEnabled: false,
          });
        } else {
          // Recurring: just disable until task-runner re-enables after completion
          await updateTask(taskId, { scheduleEnabled: false });
        }

        spawnTask(taskId, broadcastFn, userId, userRole, allowedPath);
        console.log(`[scheduler] Spawned task "${row.title}" (${taskId.slice(0, 8)})`);
      } catch (err: any) {
        console.error(`[scheduler] Failed to spawn task ${taskId.slice(0, 8)}:`, err.message);
        // If spawn fails (e.g. max concurrent), re-enable so next tick retries
        if (row.schedule_cron) {
          await updateTask(taskId, { scheduleEnabled: true });
        }
      }
    }
  } catch (err: any) {
    console.error('[scheduler] Tick error:', err.message);
  }
}

/**
 * Start the scheduler. Call once from index.ts after server is ready.
 */
export function startScheduler(broadcastFn: BroadcastFn): void {
  if (schedulerTimer) {
    console.warn('[scheduler] Already running');
    return;
  }

  // Run first tick immediately to catch overdue tasks from downtime
  tick(broadcastFn);

  schedulerTimer = setInterval(() => tick(broadcastFn), SCHEDULER_INTERVAL);
  console.log(`[scheduler] Started (interval=${SCHEDULER_INTERVAL / 1000}s)`);
}

/**
 * Stop the scheduler (for graceful shutdown).
 */
export function stopScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log('[scheduler] Stopped');
  }
}
