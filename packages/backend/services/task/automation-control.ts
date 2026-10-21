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
import { automationResultSessionId } from './automation-result-reference.js';
import { notifyExecutionReport } from '../notification-hub.js';
import { v4 as uuidv4 } from 'uuid';
import { selectManualAutomationExecutionPath } from '../execution/execution-control-plane-policy.js';
import { executeAutomationViaExecutionControlPlane } from '../execution/automation-execution-orchestrator.js';

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

async function runManualAutomationViaExecutionControlPlane(params: {
  automation: Automation;
  broadcast?: BroadcastFn;
}): Promise<AutomationControlResult> {
  const { automation } = params;
  if (!params.broadcast) throw new Error('Execution Control Plane AI spawn requires broadcast');
  const commandId = uuidv4();
  const executionResult = await executeAutomationViaExecutionControlPlane({
    automation, trigger: 'manual',
    idempotencyKey: `automation:${automation.id}:manual:${commandId}`,
    broadcast: params.broadcast,
  });
  const result = executionResult.result;
  const finishedAt = new Date().toISOString();
  const success = executionResult.executionStatus === 'succeeded';
  await recordAutomationRuntimeResult(automation.id, result.status, result.error || null);
  if (automation.triggerType === 'once') await updateAutomation(automation.id, { enabled: false });
  await appendProcessEvent({
    projectId: automation.projectId, sessionId: executionResult.sessionId, automationId: automation.id,
    runId: executionResult.automationRunId, executionId: executionResult.executionId,
    sourceType: 'automation_run', sourceId: executionResult.automationRunId,
    eventType: success ? 'step_completed' : 'step_failed',
    rawLabel: success ? 'Automation run completed' : 'Automation run failed',
    rawPayload: { status: result.status, trigger: 'manual', runnerKind: result.runnerKind,
      executionPath: 'execution_control_plane', executionStatus: executionResult.executionStatus, error: result.error || null },
    occurredAt: finishedAt,
  });
  if (result.status !== 'none') await notifyExecutionReport({
    userId: automation.userId, kind: 'automation', sourceId: automation.id, name: automation.name,
    status: success ? 'completed' : 'failed', body: result.summaryText || result.error || undefined,
    projectId: automation.projectId, sessionId: executionResult.sessionId,
    actionUrl: executionResult.sessionId ? `/s/${executionResult.sessionId}` : '/work',
    metadata: { automationId: automation.id, runId: executionResult.automationRunId,
      executionId: executionResult.executionId, executionPath: 'execution_control_plane', trigger: 'manual', runnerKind: result.runnerKind },
  }).catch((err: any) => {
    console.warn(`[automation-control] Notification report failed for ${automation.id}:`, err.message);
  });
  return { ...result, runId: executionResult.automationRunId };
}

/** Preserve recurring schedules; consume one-shot executions and record runner failures. */
export async function runAutomationNow(params: {
  automation: Automation;
  broadcast?: BroadcastFn;
}): Promise<AutomationControlResult> {
  const { automation } = params;
  if ((automation.definitionJson?.creationPlan as any)?.status === 'draft') {
    throw new Error('Creation plan must be reviewed and activated before running');
  }
  const pathDecision = selectManualAutomationExecutionPath(automation);
  if (pathDecision.path === 'execution_control_plane') {
    return runManualAutomationViaExecutionControlPlane(params);
  }
  const startedAt = new Date().toISOString();
  const start = Date.now();
  let result: AutomationRunResult;
  try {
    result = await runAutomationJob(automation, params.broadcast);
  } catch (err) {
    result = { status: 'failed', resultId: null, error: err instanceof Error ? err.message : String(err), runnerKind: 'system' };
  }
  // A concurrent run is not a new execution and must not consume a one-shot.
  if (result.status === 'skipped') return { ...result, runId: '' };
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
  if (automation.triggerType === 'once') await updateAutomation(automation.id, { enabled: false });

  await appendProcessEvent({
    projectId: automation.projectId,
    sessionId: automationResultSessionId(result, automation),
    automationId: automation.id,
    runId,
    sourceType: 'automation_run',
    sourceId: runId,
    eventType: result.status === 'spawned' ? 'step_started' : (result.status === 'success' || result.status === 'none') ? 'step_completed' : 'step_failed',
    rawLabel: result.status === 'spawned' ? 'AI task started; outcome unverified' : result.status === 'none' ? 'Automation checked; no work' : result.status === 'success' ? 'Automation run completed' : 'Automation run failed',
    rawPayload: {
      status: result.status,
      trigger: 'manual',
      runnerKind: result.runnerKind,
      executionPath: 'legacy',
      executionPathReason: pathDecision.reason,
      featureFlagState: pathDecision.flag,
      error: result.error || null,
    },
    occurredAt: finishedAt,
  });

  // Admission is not a terminal result. Do not emit a completion notification.
  if (result.status === 'spawned' || result.status === 'none') return { ...result, runId };
  const sessionId = automationResultSessionId(result, automation);
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
    metadata: {
      automationId: automation.id,
      runId,
      executionPath: 'legacy',
      executionPathReason: pathDecision.reason,
      featureFlagState: pathDecision.flag,
      trigger: 'manual',
      runnerKind: result.runnerKind,
    },
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
  if ((automation.definitionJson?.creationPlan as any)?.status === 'draft') {
    throw new Error('Creation plan must be reviewed and activated before enabling');
  }
  return updateAutomation(automation.id, { enabled, updatedByUserId });
}

export async function archiveAutomationJob(automation: Automation): Promise<boolean> {
  return deleteAutomation(automation.id);
}
