/**
 * Owns: auditable manual control operations shared by REST and agent tools.
 * Public API: runAutomationNow(), setAutomationEnabled(), archiveAutomationJob().
 */
import { appendProcessEvent } from '../process/process-map-manager.js';
import {
  deleteAutomation,
  getAutomation,
  logRun,
  recordAutomationRuntimeResult,
  updateAutomation,
  type Automation,
} from './automation-manager.js';
import { runAutomationJob, type AutomationRunResult, type BroadcastFn } from './automation-runners.js';
import { canAccessAutomationJob, type PermissionResult } from './schedule-permissions.js';
import { notifyExecutionReport } from '../notification-hub.js';

export interface AutomationControlActor {
  userId: number | undefined;
  role?: string | null;
}

export interface AutomationControlResult extends AutomationRunResult {
  runId: string;
}

export async function requireAutomationCapability(
  automationId: string,
  actor: AutomationControlActor,
  capability: 'read' | 'propose' | 'run' | 'edit' | 'archive',
): Promise<{ automation: Automation | null; access: PermissionResult }> {
  const automation = await getAutomation(automationId);
  if (!automation) return { automation: null, access: { allowed: false, status: 404, message: 'not found' } };
  const access = await canAccessAutomationJob(automation, actor.userId, actor.role, capability);
  return { automation, access };
}

/** Run once without advancing the recurring schedule's next_run_at. */
export async function runAutomationNow(params: {
  automation: Automation;
  broadcast?: BroadcastFn;
}): Promise<AutomationControlResult> {
  const { automation } = params;
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const result = await runAutomationJob(automation, params.broadcast);
  const finishedAt = new Date().toISOString();

  const runId = await logRun({
    automationId: automation.id,
    status: result.status,
    mode: automation.mode,
    resultId: result.resultId,
    error: result.error || null,
    durationMs: Date.now() - start,
    trigger: 'manual',
    startedAt,
    finishedAt,
    stdoutText: result.stdoutText || null,
    stderrText: result.stderrText || null,
    summaryText: result.summaryText || null,
    errorJson: result.errorJson || null,
    runnerKind: result.runnerKind,
    runnerRef: result.runnerRef || null,
  });
  await recordAutomationRuntimeResult(automation.id, result.status, result.error || null);

  await appendProcessEvent({
    projectId: automation.projectId,
    sessionId: result.resultId || automation.sessionId || null,
    automationId: automation.id,
    runId,
    sourceType: 'automation_run',
    sourceId: runId,
    eventType: result.status === 'success' ? 'step_completed' : 'step_failed',
    rawLabel: result.status === 'success' ? 'Automation run completed' : 'Automation run failed',
    rawPayload: { status: result.status, trigger: 'manual', runnerKind: result.runnerKind, error: result.error || null },
    occurredAt: finishedAt,
  });

  const sessionId = result.runnerKind === 'ai' && result.runnerRef?.startsWith('workbench-') !== true
    ? result.resultId
    : null;
  await notifyExecutionReport({
    userId: automation.userId,
    kind: 'automation',
    sourceId: automation.id,
    name: automation.name,
    status: result.status === 'success' ? 'completed' : 'failed',
    body: result.summaryText || result.error || undefined,
    projectId: automation.projectId,
    sessionId,
    actionUrl: sessionId ? `/s/${sessionId}` : '/work',
    metadata: { automationId: automation.id, runId, trigger: 'manual', runnerKind: result.runnerKind },
  }).catch((err: any) => {
    console.warn(`[automation-control] Notification report failed for ${automation.id}:`, err.message);
  });

  return { ...result, runId };
}

export async function setAutomationEnabled(
  automation: Automation,
  enabled: boolean,
  updatedByUserId: number,
): Promise<Automation | null> {
  return updateAutomation(automation.id, { enabled, updatedByUserId });
}

export async function archiveAutomationJob(automation: Automation): Promise<boolean> {
  return deleteAutomation(automation.id);
}
