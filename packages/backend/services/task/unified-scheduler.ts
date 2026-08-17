/**
 * Unified Scheduler — 30초마다 due 스케줄을 체크하고 모드별로 실행.
 *
 * 세 가지 실행 모드:
 *   - spawn:   새 태스크 생성 → 칸반 보드에 결과
 *   - inject:  기존 세션에 AI 메시지 주입 → 세션 내 대화 계속
 *   - channel: 새 proactive 세션 생성 → 채널에 요약 게시
 *
 * 기존 task-scheduler.ts를 대체한다.
 */

import { query, queryOne, execute } from '../../db/pg-repo.js';
import { createTask } from './task-manager.js';
import { spawnTask } from './task-runner.js';
import { fireProactive } from '../ai/proactive-agent.js';
import { config, getModelDefaults } from '../../config.js';
import { v4 as uuidv4 } from 'uuid';
import { normalizeSeverity, routeSeverity, type TowerSeverity } from '../tower/severity-router.js';
import { notifyExecutionReport } from '../notification-hub.js';
import { getAccessibleProjectIds } from '../pm/project-membership-manager.js';
import { getProject } from '../pm/project-manager.js';

// ── Types ──

export interface ScheduleEntry {
  id: string;
  userId: number;
  projectId: string | null;
  name: string;
  prompt: string;
  model: string;
  mode: 'spawn' | 'inject' | 'channel';
  targetId: string | null;
  triggerType: 'cron' | 'once';
  cronConfig: CronConfig | null;
  onceAt: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runCount: number;
  lastStatus: string | null;
  lastError: string | null;
  /** Tower channel severity for run reports (default L2 — see migration 048). */
  severity: TowerSeverity;
  createdAt: string;
  updatedAt: string;
}

export interface CronConfig {
  type: 'daily' | 'weekdays' | 'weekly' | 'interval';
  hour?: number;
  minute?: number;
  day?: number;   // 0=Sun..6=Sat (for 'weekly')
  hours?: number; // for 'interval' (legacy hours-only form)
  /**
   * Minutes-based interval (1..10080 = 1주). Takes precedence over `hours`
   * when both are set. Added 2026-05-16. Validate at API boundary via
   * task-scheduler.ts `validateCron()` (same interval limits apply).
   */
  minutes?: number;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  status: string;
  mode: string;
  resultId: string | null;
  error: string | null;
  durationMs: number | null;
  ranAt: string;
}

type BroadcastFn = (type: string, data: any) => void;

// ── Constants ──

const TICK_INTERVAL = 30_000; // 30 seconds
const MAX_PER_TICK = 20;
/**
 * Legacy `schedules` table tick is disabled by default after the Schedule tab
 * moved to the `automations` registry. Legacy task schedules remain active via
 * tickLegacyTasks(); this flag only affects rows in the old `schedules` table.
 */
const ENABLE_LEGACY_SCHEDULE_TICK = process.env.ENABLE_LEGACY_SCHEDULE_TICK === 'true';


let tickTimer: ReturnType<typeof setInterval> | null = null;
let broadcastRef: BroadcastFn | null = null;

// ── Row mapping ──

function mapRow(row: any): ScheduleEntry {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id || null,
    name: row.name,
    prompt: row.prompt,
    model: row.model || getModelDefaults().session,
    mode: row.mode || 'spawn',
    targetId: row.target_id || null,
    triggerType: row.trigger_type || 'cron',
    cronConfig: row.cron_config || null,
    onceAt: row.once_at || null,
    enabled: row.enabled ?? true,
    nextRunAt: row.next_run_at || null,
    lastRunAt: row.last_run_at || null,
    runCount: row.run_count || 0,
    lastStatus: row.last_status || null,
    lastError: row.last_error || null,
    severity: normalizeSeverity(row.severity),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Next run calculation (reused from task-scheduler) ──

export function calculateNextRun(cron: CronConfig, from: Date = new Date()): Date {
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
      while (next.getDay() === 0 || next.getDay() === 6) {
        next.setDate(next.getDate() + 1);
      }
      return next;
    }
    case 'weekly': {
      const targetDay = cron.day ?? 1;
      next.setHours(cron.hour ?? 9, cron.minute ?? 0, 0, 0);
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
      return new Date(from.getTime() + 3600_000);
  }
}

// ── Tick ──

async function tick() {
  if (!broadcastRef) return;

  try {
    const now = new Date().toISOString();
    const dueRows = await query<any>(`
      SELECT * FROM schedules
      WHERE enabled = true
        AND next_run_at IS NOT NULL
        AND next_run_at <= $1
      ORDER BY next_run_at ASC
      LIMIT $2
    `, [now, MAX_PER_TICK]);

    if (dueRows.length === 0) return;

    console.log(`[unified-scheduler] Found ${dueRows.length} due schedule(s)`);

    for (const row of dueRows) {
      const schedule = mapRow(row);
      const startTime = Date.now();

      try {
        let resultId: string | null = null;

        switch (schedule.mode) {
          case 'spawn':
            resultId = await executeSpawn(schedule);
            break;
          case 'inject':
            resultId = await executeInject(schedule);
            break;
          case 'channel':
            resultId = await executeChannel(schedule);
            break;
          default:
            throw new Error(`Unknown schedule mode: ${schedule.mode}`);
        }

        const durationMs = Date.now() - startTime;
        await logRun(schedule.id, 'success', schedule.mode, resultId, null, durationMs);
        await advanceSchedule(schedule, 'success', null);
        await notifyTowerOfRun(schedule, 'success', durationMs, resultId, null);

        console.log(`[unified-scheduler] ✓ ${schedule.mode} "${schedule.name}" (${durationMs}ms)`);

      } catch (err: any) {
        const durationMs = Date.now() - startTime;
        await logRun(schedule.id, 'failed', schedule.mode, null, err.message, durationMs);
        await advanceSchedule(schedule, 'failed', err.message);
        await notifyTowerOfRun(schedule, 'failed', durationMs, null, err.message);

        console.error(`[unified-scheduler] ✗ ${schedule.mode} "${schedule.name}":`, err.message);
      }
    }
  } catch (err: any) {
    console.error('[unified-scheduler] Tick error:', err.message);
  }
}

// ── Also handle legacy tasks (backward compat during transition) ──

async function tickLegacyTasks() {
  if (!broadcastRef) return;

  try {
    const now = new Date().toISOString();
    const dueTasks = await query<any>(`
      SELECT * FROM tasks
      WHERE status = 'todo'
        AND schedule_enabled = 1
        AND scheduled_at IS NOT NULL
        AND scheduled_at <= $1
        AND (archived IS NULL OR archived = 0)
        AND id NOT IN (SELECT COALESCE(target_id, '') FROM schedules WHERE mode = 'spawn')
      ORDER BY scheduled_at ASC
    `, [now]);

    for (const row of dueTasks) {
      try {
        if (!row.schedule_cron) {
          await execute(`UPDATE tasks SET scheduled_at = NULL, schedule_enabled = 0 WHERE id = $1`, [row.id]);
        } else {
          await execute(`UPDATE tasks SET schedule_enabled = 0 WHERE id = $1`, [row.id]);
        }
        spawnTask(row.id, broadcastRef, row.user_id);
        console.log(`[unified-scheduler] Legacy task spawned: "${row.title}"`);
      } catch (err: any) {
        console.error(`[unified-scheduler] Legacy task error: ${err.message}`);
        if (row.schedule_cron) {
          await execute(`UPDATE tasks SET schedule_enabled = 1 WHERE id = $1`, [row.id]);
        }
      }
    }
  } catch {
    // silent
  }
}

// ── Mode executors ──

async function executeSpawn(schedule: ScheduleEntry): Promise<string> {
  const cwd = await resolveScheduleCwd(schedule);

  const task = await createTask(
    schedule.name,
    schedule.prompt,
    cwd,
    schedule.userId,
    schedule.model,
    undefined, // no schedule on task itself
    'auto',
    undefined,
    schedule.projectId || undefined,
  );

  broadcastRef!('task_created', { task });
  // No live actor is present during scheduler ticks. task-runner resolves the
  // persisted schedule.userId's current DB role for the run-as context.
  spawnTask(task.id, broadcastRef!, schedule.userId);
  return task.id;
}

async function resolveScheduleCwd(schedule: ScheduleEntry): Promise<string> {
  if (!schedule.projectId) return config.workspaceRoot;
  const project = await getProject(schedule.projectId);
  if (project?.rootPath) return project.rootPath;
  // Compatibility fallback only; project IDs are UUIDs while folders usually
  // use slugs, so new rows should rely on projects.root_path.
  return `${config.workspaceRoot}/projects/${schedule.projectId}`;
}

async function executeInject(schedule: ScheduleEntry): Promise<string> {
  if (!schedule.targetId) {
    throw new Error('inject mode requires target_id (session_id)');
  }

  const result = await fireProactive(
    schedule.userId,
    {
      id: `schedule-${schedule.id}`,
      name: schedule.name,
      prompt: schedule.prompt,
      model: schedule.model,
      projectId: schedule.projectId || undefined,
    },
    {
      summary: `스케줄 실행: ${schedule.name}`,
      triggerMeta: { scheduleId: schedule.id },
    },
    { targetSessionId: schedule.targetId },
  );

  return result.sessionId;
}

async function executeChannel(schedule: ScheduleEntry): Promise<string> {
  // Legacy compatibility: run old channel-mode rows as a normal proactive
  // execution Session. Reporting now flows through Notification Hub below.
  const result = await fireProactive(
    schedule.userId,
    {
      id: `schedule-${schedule.id}`,
      name: schedule.name,
      prompt: schedule.prompt,
      model: schedule.model,
      projectId: schedule.projectId || undefined,
    },
    {
      summary: `스케줄 실행: ${schedule.name}`,
      triggerMeta: { scheduleId: schedule.id, legacyMode: 'channel' },
    },
  );

  return result.sessionId;
}

// ── Schedule advancement ──

async function advanceSchedule(schedule: ScheduleEntry, status: string, error: string | null) {
  if (schedule.triggerType === 'once') {
    await execute(`
      UPDATE schedules
      SET enabled = false, last_run_at = NOW(), run_count = run_count + 1,
          last_status = $1, last_error = $2, updated_at = NOW()
      WHERE id = $3
    `, [status, error, schedule.id]);
  } else if (schedule.triggerType === 'cron' && schedule.cronConfig) {
    const nextRun = calculateNextRun(schedule.cronConfig);
    await execute(`
      UPDATE schedules
      SET next_run_at = $1, last_run_at = NOW(), run_count = run_count + 1,
          last_status = $2, last_error = $3, updated_at = NOW()
      WHERE id = $4
    `, [nextRun.toISOString(), status, error, schedule.id]);
  }
}

// ── Notification report ──

/**
 * Create a policy-controlled Notification after a schedule fires.
 * L1 remains silent; detailed output stays on the Task/Session run.
 */
async function notifyTowerOfRun(
  schedule: ScheduleEntry,
  status: 'success' | 'failed',
  durationMs: number,
  resultId: string | null,
  error: string | null,
): Promise<void> {
  try {
    const severity = status === 'failed' ? bumpForFailure(schedule.severity) : schedule.severity;
    const route = routeSeverity(severity);
    if (!route.notifyInApp) return; // L1 means no Notification report.
    // spawn success only means the Task was queued; task-runner sends the
    // terminal Notification when the actual work completes.
    if (schedule.mode === 'spawn' && status === 'success') return;

    const isSessionResult = schedule.mode === 'inject' || schedule.mode === 'channel';
    const runSessionId = isSessionResult ? resultId : null;
    const taskId = !isSessionResult ? resultId : null;
    const actionUrl = runSessionId ? `/s/${runSessionId}` : '/work';
    const body = status === 'success'
      ? `${(durationMs / 1000).toFixed(1)}초 만에 실행을 마쳤습니다.`
      : error ?? '알 수 없는 오류';

    await notifyExecutionReport({
      userId: schedule.userId,
      kind: 'automation',
      sourceId: schedule.id,
      name: schedule.name,
      status: status === 'success' ? 'completed' : 'failed',
      body,
      projectId: schedule.projectId,
      sessionId: runSessionId,
      actionUrl,
      metadata: { scheduleId: schedule.id, taskId, legacyMode: schedule.mode === 'channel' ? 'channel' : undefined },
    });
  } catch (err: any) {
    console.warn('[unified-scheduler] Notification report failed (non-fatal):', err.message);
  }
}

/**
 * Failed runs deserve more attention than the default severity assumes.
 *   L2 → L3 (please review)
 *   L1 stays L1 (silent — author opted out explicitly)
 *   L3, L4 stay (already loud)
 */
function bumpForFailure(severity: TowerSeverity): TowerSeverity {
  if (severity === 'L2') return 'L3';
  return severity;
}

// ── Run logging ──

async function logRun(
  scheduleId: string,
  status: string,
  mode: string,
  resultId: string | null,
  error: string | null,
  durationMs: number,
) {
  await execute(`
    INSERT INTO schedule_runs (id, schedule_id, status, mode, result_id, error, duration_ms)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [uuidv4(), scheduleId, status, mode, resultId, error, durationMs]);
}

// ── CRUD ──

export async function getSchedules(userId?: number, role?: string): Promise<ScheduleEntry[]> {
  const rows = await query<any>(
    'SELECT * FROM schedules ORDER BY created_at DESC',
  );

  if (userId && role) {
    const accessibleIds = await getAccessibleProjectIds(userId, role);
    if (accessibleIds !== null) {
      // Non-admin: project schedules by group, non-project schedules by creator
      return rows.filter(r => {
        if (!r.project_id) return r.user_id === userId;
        return accessibleIds.includes(r.project_id);
      }).map(mapRow);
    }
  }

  // Admin/operator or no auth: show all
  return rows.map(mapRow);
}

export async function getSchedule(id: string): Promise<ScheduleEntry | null> {
  const row = await queryOne<any>('SELECT * FROM schedules WHERE id = $1', [id]);
  return row ? mapRow(row) : null;
}

export async function createSchedule(data: {
  userId: number;
  projectId?: string;
  name: string;
  prompt: string;
  model?: string;
  mode: 'spawn' | 'inject' | 'channel';
  targetId?: string;
  triggerType: 'cron' | 'once';
  cronConfig?: CronConfig;
  onceAt?: string;
}): Promise<ScheduleEntry> {
  const id = uuidv4();

  // Calculate initial next_run_at
  let nextRunAt: string | null = null;
  if (data.triggerType === 'once' && data.onceAt) {
    nextRunAt = new Date(data.onceAt).toISOString();
  } else if (data.triggerType === 'cron' && data.cronConfig) {
    nextRunAt = calculateNextRun(data.cronConfig).toISOString();
  }

  await execute(`
    INSERT INTO schedules (id, user_id, project_id, name, prompt, model, mode, target_id, trigger_type, cron_config, once_at, next_run_at, enabled)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)
  `, [
    id,
    data.userId,
    data.projectId || null,
    data.name,
    data.prompt,
    data.model || getModelDefaults().session,
    data.mode,
    data.targetId || null,
    data.triggerType,
    data.cronConfig ? JSON.stringify(data.cronConfig) : null,
    data.onceAt || null,
    nextRunAt,
  ]);

  return (await getSchedule(id))!;
}

export async function updateSchedule(id: string, updates: Partial<{
  name: string;
  prompt: string;
  model: string;
  mode: 'spawn' | 'inject' | 'channel';
  targetId: string | null;
  triggerType: 'cron' | 'once';
  cronConfig: CronConfig | null;
  onceAt: string | null;
  enabled: boolean;
}>): Promise<ScheduleEntry | null> {
  const existing = await getSchedule(id);
  if (!existing) return null;

  const sets: string[] = [];
  const values: any[] = [];
  let idx = 1;

  const addField = (field: string, val: any) => {
    sets.push(`${field} = $${idx}`);
    values.push(val);
    idx++;
  };

  if (updates.name !== undefined) addField('name', updates.name);
  if (updates.prompt !== undefined) addField('prompt', updates.prompt);
  if (updates.model !== undefined) addField('model', updates.model);
  if (updates.mode !== undefined) addField('mode', updates.mode);
  if (updates.targetId !== undefined) addField('target_id', updates.targetId);
  if (updates.triggerType !== undefined) addField('trigger_type', updates.triggerType);
  if (updates.cronConfig !== undefined) addField('cron_config', updates.cronConfig ? JSON.stringify(updates.cronConfig) : null);
  if (updates.onceAt !== undefined) addField('once_at', updates.onceAt);
  if (updates.enabled !== undefined) addField('enabled', updates.enabled);

  // Recalculate next_run_at if schedule parameters changed
  const triggerType = updates.triggerType ?? existing.triggerType;
  const cronConfig = updates.cronConfig !== undefined ? updates.cronConfig : existing.cronConfig;
  const onceAt = updates.onceAt !== undefined ? updates.onceAt : existing.onceAt;
  const enabled = updates.enabled ?? existing.enabled;

  if (enabled) {
    let nextRunAt: string | null = null;
    if (triggerType === 'once' && onceAt) {
      nextRunAt = new Date(onceAt).toISOString();
    } else if (triggerType === 'cron' && cronConfig) {
      nextRunAt = calculateNextRun(cronConfig).toISOString();
    }
    addField('next_run_at', nextRunAt);
  } else {
    addField('next_run_at', null);
  }

  addField('updated_at', new Date().toISOString());

  if (sets.length === 0) return existing;

  values.push(id);
  await execute(`UPDATE schedules SET ${sets.join(', ')} WHERE id = $${idx}`, values);

  return getSchedule(id);
}

export async function deleteSchedule(id: string): Promise<boolean> {
  await execute('DELETE FROM schedules WHERE id = $1', [id]);
  return true;
}

export async function getScheduleRuns(scheduleId: string, limit = 20): Promise<ScheduleRun[]> {
  const rows = await query<any>(
    'SELECT * FROM schedule_runs WHERE schedule_id = $1 ORDER BY ran_at DESC LIMIT $2',
    [scheduleId, limit],
  );
  return rows.map((r: any) => ({
    id: r.id,
    scheduleId: r.schedule_id,
    status: r.status,
    mode: r.mode,
    resultId: r.result_id,
    error: r.error,
    durationMs: r.duration_ms,
    ranAt: r.ran_at,
  }));
}

/** Run a schedule immediately (for testing / manual trigger) */
export async function runScheduleNow(id: string): Promise<{ resultId: string | null; status: string }> {
  const schedule = await getSchedule(id);
  if (!schedule) throw new Error('Schedule not found');
  if (!broadcastRef) throw new Error('Scheduler not initialized');

  const startTime = Date.now();

  try {
    let resultId: string | null = null;

    switch (schedule.mode) {
      case 'spawn':
        resultId = await executeSpawn(schedule);
        break;
      case 'inject':
        resultId = await executeInject(schedule);
        break;
      case 'channel':
        resultId = await executeChannel(schedule);
        break;
    }

    const durationMs = Date.now() - startTime;
    await logRun(id, 'success', schedule.mode, resultId, null, durationMs);

    // Manual run usually shouldn't disturb the cron flow, but a 'once' schedule
    // is by definition consumed when it fires — keeping it enabled lets the
    // tick refire it when next_run_at arrives, causing duplicate work
    // (regression hit during 2026-05-05 Phase 2 smoke testing).
    const oneShotConsumed = schedule.triggerType === 'once';
    const consumedClause = oneShotConsumed ? ', enabled = false, next_run_at = NULL' : '';
    await execute(`
      UPDATE schedules SET last_run_at = NOW(), run_count = run_count + 1,
        last_status = 'success', last_error = NULL, updated_at = NOW()${consumedClause}
      WHERE id = $1
    `, [id]);
    await notifyTowerOfRun(schedule, 'success', durationMs, resultId, null);

    return { resultId, status: 'success' };
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    await logRun(id, 'failed', schedule.mode, null, err.message, durationMs);

    // Same 'once' consumption rule applies on failure — a one-shot schedule
    // fired (even if it errored). Don't refire automatically; the user can
    // re-enable manually if they want a retry.
    const oneShotConsumed = schedule.triggerType === 'once';
    const consumedClause = oneShotConsumed ? ', enabled = false, next_run_at = NULL' : '';
    await execute(`
      UPDATE schedules SET last_run_at = NOW(), run_count = run_count + 1,
        last_status = 'failed', last_error = $1, updated_at = NOW()${consumedClause}
      WHERE id = $2
    `, [err.message, id]);
    await notifyTowerOfRun(schedule, 'failed', durationMs, null, err.message);

    throw err;
  }
}

// ── Automations table tick (new unified table) ──

async function tickAutomations() {
  if (!broadcastRef) return;

  try {
    const now = new Date().toISOString();
    const dueRows = await query<any>(`
      SELECT * FROM automations
      WHERE enabled = true
        AND trigger_type IN ('cron', 'once')
        AND next_run_at IS NOT NULL
        AND next_run_at <= $1
        AND status != 'archived'
      ORDER BY next_run_at ASC
      LIMIT $2
    `, [now, MAX_PER_TICK]);

    if (dueRows.length === 0) return;

    console.log(`[unified-scheduler] Found ${dueRows.length} due automation(s)`);

    // Import dynamically to avoid circular deps at module load time.
    const { advanceSchedule: advanceAuto, getAutomation, logRun: logAutoRun } = await import('./automation-manager.js');
    const { runAutomationJob } = await import('./automation-runners.js');
    const { decideDueRunAction } = await import('./missed-run-policy.js');

    for (const row of dueRows) {
      const automation = await getAutomation(row.id);
      if (!automation) continue;
      const startTime = Date.now();
      const startedAt = new Date().toISOString();
      const dueAction = decideDueRunAction(automation as any);
      if (dueAction.action === 'skip') {
        await logAutoRun({
          automationId: automation.id,
          status: 'skipped',
          mode: automation.mode,
          resultId: null,
          error: dueAction.reason,
          durationMs: 0,
          trigger: 'schedule',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          summaryText: `Skipped missed run: ${dueAction.reason}`,
          errorJson: { latenessMs: dueAction.latenessMs },
          runnerKind: 'system',
        });
        await advanceAuto(automation, 'skipped', dueAction.reason);
        console.log(`[unified-scheduler] skipped overdue automation "${automation.name}": ${dueAction.reason}`);
        continue;
      }

      const autoEntry: ScheduleEntry = {
        id: automation.id,
        userId: automation.userId,
        projectId: automation.projectId,
        name: automation.name,
        prompt: automation.prompt || automation.description || automation.name,
        model: automation.model || getModelDefaults().session,
        mode: automation.mode,
        targetId: automation.targetId,
        triggerType: automation.triggerType === 'once' ? 'once' : 'cron',
        cronConfig: automation.cronConfig,
        onceAt: automation.onceAt,
        enabled: automation.enabled,
        nextRunAt: automation.nextRunAt,
        lastRunAt: automation.lastRunAt,
        runCount: automation.runCount,
        lastStatus: automation.lastStatus,
        lastError: automation.lastError,
        severity: normalizeSeverity(row.severity),
        createdAt: automation.createdAt,
        updatedAt: automation.updatedAt,
      };

      try {
        const result = await runAutomationJob(automation, broadcastRef || undefined);
        const durationMs = Date.now() - startTime;
        const finishedAt = new Date().toISOString();
        await logAutoRun({
          automationId: automation.id,
          status: result.status,
          mode: automation.mode,
          resultId: result.resultId,
          error: result.error || null,
          durationMs,
          trigger: 'schedule',
          startedAt,
          finishedAt,
          stdoutText: result.stdoutText || null,
          stderrText: result.stderrText || null,
          summaryText: result.summaryText || null,
          errorJson: result.errorJson || null,
          runnerKind: result.runnerKind,
          runnerRef: result.runnerRef || null,
        });
        await advanceAuto(automation, result.status, result.error || null);
        await notifyTowerOfRun(autoEntry, result.status === 'success' ? 'success' : 'failed', durationMs, result.resultId, result.error || null);

        console.log(`[unified-scheduler] ✓ automation ${automation.jobType}/${automation.mode} "${automation.name}" (${durationMs}ms)`);

      } catch (err: any) {
        const durationMs = Date.now() - startTime;
        const finishedAt = new Date().toISOString();
        await logAutoRun({
          automationId: automation.id,
          status: 'failed',
          mode: automation.mode,
          resultId: null,
          error: err.message,
          durationMs,
          trigger: 'schedule',
          startedAt,
          finishedAt,
          summaryText: err.message,
          errorJson: { message: err.message },
          runnerKind: 'system',
        });
        await advanceAuto(automation, 'failed', err.message);
        await notifyTowerOfRun(autoEntry, 'failed', durationMs, null, err.message);

        console.error(`[unified-scheduler] ✗ automation ${automation.jobType}/${automation.mode} "${automation.name}":`, err.message);
      }
    }
  } catch (err: any) {
    console.error('[unified-scheduler] Automations tick error:', err.message);
  }
}

// ── Lifecycle ──

export function startUnifiedScheduler(broadcast: BroadcastFn): void {
  if (tickTimer) {
    console.warn('[unified-scheduler] Already running');
    return;
  }

  broadcastRef = broadcast;

  // Run first tick immediately. `schedules` table tick is legacy/off by default;
  // `tasks` scheduled_at compatibility remains on until Task tab migration ends.
  if (ENABLE_LEGACY_SCHEDULE_TICK) tick();
  tickLegacyTasks();
  tickAutomations();

  tickTimer = setInterval(() => {
    if (ENABLE_LEGACY_SCHEDULE_TICK) tick();
    tickLegacyTasks();
    tickAutomations();
  }, TICK_INTERVAL);

  console.log(`[unified-scheduler] Started (interval=${TICK_INTERVAL / 1000}s)`);
}

export function stopUnifiedScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
    broadcastRef = null;
    console.log('[unified-scheduler] Stopped');
  }
}
