/**
 * Unified Scheduler — 30초마다 Automation Registry의 due job을 실행한다.
 * Legacy tasks/schedules 실행기는 퇴역했으며 이 모듈은 automations만 소비한다.
 */

import { query } from '../../db/pg-repo.js';
import { scheduledExecutionEnabled, withSchedulerTickLock } from './scheduler-ownership.js';
import { automationResultSessionId } from './automation-result-reference.js';
import { normalizeSeverity, routeSeverity, type TowerSeverity } from '../tower/severity-router.js';
import { notifyExecutionReport } from '../notification-hub.js';
import { selectAutomationExecutionPath } from '../execution/execution-control-plane-policy.js';
import { executeAutomationViaExecutionControlPlane } from '../execution/automation-execution-orchestrator.js';
import { appendProcessEvent } from '../process/process-map-manager.js';
import { hasScheduledAutomationExecution } from '../execution/scheduled-occurrence-lookup.js';

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

let tickTimer: ReturnType<typeof setInterval> | null = null;
let broadcastRef: BroadcastFn | null = null;

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
  terminalSession?: { sessionId: string | null; summary?: string | null; runId?: string; executionId?: string },
): Promise<void> {
  try {
    const severity = status === 'failed' ? bumpForFailure(schedule.severity) : schedule.severity;
    const route = routeSeverity(severity);
    if (!route.notifyInApp) return; // L1 means no Notification report.
    // Admission alone is not completion. Automation-owned Tasks are silent;
    // this path reports only a persisted terminal Run, not Task dispatch.
    if (schedule.mode === 'spawn' && status === 'success' && !terminalSession) return;

    const isSessionResult = schedule.mode === 'inject' || schedule.mode === 'channel';
    const runSessionId = terminalSession ? terminalSession.sessionId : isSessionResult ? resultId : null;
    const taskId = !isSessionResult ? resultId : null;
    const actionUrl = runSessionId ? `/s/${runSessionId}` : '/work';
    const body = terminalSession?.summary || (status === 'success'
      ? `${(durationMs / 1000).toFixed(1)}초 만에 실행을 마쳤습니다.`
      : error ?? '알 수 없는 오류');

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
      metadata: { scheduleId: schedule.id, automationId: schedule.id, runId: terminalSession?.runId,
        executionId: terminalSession?.executionId, taskId, legacyMode: schedule.mode === 'channel' ? 'channel' : undefined },
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

// ── Automations table tick (new unified table) ──

// A slow execution must not let the next timer tick consume the same occurrence.
let automationTickRunning = false;
async function tickAutomations() {
  if (!broadcastRef || automationTickRunning) return;
  automationTickRunning = true;

  try {
    await withSchedulerTickLock(async () => {
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
      if (!automation || !automation.enabled || automation.status === 'archived') continue;
      const startTime = Date.now();
      const startedAt = new Date().toISOString();
      const pathDecision = selectAutomationExecutionPath(automation);
      const dueAction = decideDueRunAction(automation as any);
      let hasExistingOccurrence = false;
      if (dueAction.action === 'skip' && pathDecision.path === 'execution_control_plane') {
        try {
          hasExistingOccurrence = await hasScheduledAutomationExecution(automation.id, automation.nextRunAt!);
        } catch (err: any) {
          // Absence must be proven before consuming a missed occurrence.
          console.error(`[unified-scheduler] Occurrence lookup failed for "${automation.name}"; dueAt preserved:`, err.message);
          continue;
        }
      }
      if (dueAction.action === 'skip' && !hasExistingOccurrence) {
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
        model: automation.model || 'preset/core',
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
        const dueAt = automation.nextRunAt;
        const executionResult = pathDecision.path === 'execution_control_plane'
          ? await executeAutomationViaExecutionControlPlane({
              automation,
              trigger: 'schedule',
              dueAt,
              idempotencyKey: `automation:${automation.id}:schedule:${new Date(String(dueAt)).toISOString()}`,
              broadcast: broadcastRef!,
            })
          : null;
        const result = executionResult?.result || await runAutomationJob(automation, broadcastRef || undefined);
        if (result.status === 'skipped') continue; // Lock contention is not an execution or a consumed occurrence.
        const durationMs = Date.now() - startTime;
        const finishedAt = new Date().toISOString();
        const runId = executionResult ? executionResult.automationRunId : await logAutoRun({
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
        if (executionResult && !executionResult.replayedOccurrence) {
          await appendProcessEvent({
            projectId: automation.projectId,
            sessionId: executionResult.sessionId,
            automationId: automation.id,
            runId: executionResult.automationRunId,
            executionId: executionResult.executionId,
            sourceType: 'automation_run',
            sourceId: executionResult.automationRunId,
            eventType: executionResult.executionStatus === 'succeeded' ? 'step_completed' : 'step_failed',
            rawLabel: executionResult.executionStatus === 'succeeded' ? 'Automation run completed' : 'Automation run failed',
            rawPayload: {
              status: result.status,
              trigger: 'schedule',
              dueAt,
              runnerKind: result.runnerKind,
              executionPath: 'execution_control_plane',
              executionStatus: executionResult.executionStatus,
              error: result.error || null,
            },
            occurredAt: finishedAt,
          });
        }
        if (result.status !== 'spawned' && result.status !== 'none' && !executionResult?.replayedOccurrence) {
          await notifyTowerOfRun(autoEntry, result.status === 'success' ? 'success' : 'failed', durationMs, result.resultId, result.error || null, { sessionId: executionResult?.sessionId || automationResultSessionId(result, automation), summary: result.summaryText, runId, executionId: executionResult?.executionId });
        }

        console.log(`[unified-scheduler] ✓ automation ${automation.jobType}/${automation.mode} "${automation.name}" (${durationMs}ms)`);

      } catch (err: any) {
        const durationMs = Date.now() - startTime;
        const finishedAt = new Date().toISOString();
        if (pathDecision.path === 'execution_control_plane') {
          // A thrown orchestration error is not a terminal occurrence receipt.
          // Preserve dueAt for ledger replay/recovery; never consume a one-shot
          // or issue a false completion report for a still-running execution.
          console.error(`[unified-scheduler] Execution occurrence preserved for "${automation.name}":`, err.message);
          continue;
        }
        const runId = await logAutoRun({
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
        await notifyTowerOfRun(autoEntry, 'failed', durationMs, null, err.message, { sessionId: null, runId });

        console.error(`[unified-scheduler] ✗ automation ${automation.jobType}/${automation.mode} "${automation.name}":`, err.message);
      }
    }
    });
  } catch (err: any) {
    console.error('[unified-scheduler] Automations tick error:', err.message);
  } finally {
    automationTickRunning = false;
  }
}

// ── Lifecycle ──

export function startUnifiedScheduler(broadcast: BroadcastFn): void {
  if (!scheduledExecutionEnabled()) {
    console.log('[unified-scheduler] Disabled for this deployment (TOWER_SCHEDULER_ENABLED override available)');
    return;
  }
  if (tickTimer) {
    console.warn('[unified-scheduler] Already running');
    return;
  }

  broadcastRef = broadcast;

  // All supported scheduled execution is owned by the Automation Registry.
  tickAutomations();

  tickTimer = setInterval(() => {
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
