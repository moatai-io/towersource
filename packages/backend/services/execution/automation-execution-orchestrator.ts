import { resolveAutomationAiCwd } from '../task/automation-runners.js';
import type { Automation } from '../task/automation-manager.js';
import type { AutomationRunResult, BroadcastFn } from '../task/automation-runners.js';
import { admitAutomationExecution } from './automation-execution-admission.js';
import { assertAutomationRunProjected, projectAutomationExecutionResult } from './automation-execution-projection.js';
import { executeWithLegacyTaskAdapter } from './adapters/legacy-task-execution-adapter.js';
import { settleExecution } from './completion-reconciler.js';
import { recoverExecutionFailure } from './execution-failure-recovery.js';
import { transitionExecution } from './execution-manager.js';
import { TERMINAL_EXECUTION_STATUSES } from './execution-types.js';
import { assertExecutionControlPlaneReady } from './execution-readiness.js';
import { resolveAutomationModel } from '../task/automation-model.js';

export interface AutomationExecutionControlPlaneResult {
  result: AutomationRunResult;
  executionId: string;
  automationRunId: string;
  sessionId: string | null;
  executionStatus: string;
  replayedOccurrence: boolean;
}

export async function executeAutomationViaExecutionControlPlane(params: {
  automation: Automation;
  trigger: 'manual' | 'schedule';
  idempotencyKey: string;
  dueAt?: string | null;
  broadcast: BroadcastFn;
}): Promise<AutomationExecutionControlPlaneResult> {
  await assertExecutionControlPlaneReady();
  // Resolve a managed preset once per occurrence, before admission and task creation.
  const executionModel = params.automation.jobType === 'ai_prompt'
    ? resolveAutomationModel(params.automation.model)
    : params.automation.model;
  const executionAutomation = { ...params.automation, model: executionModel };
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const admitted = await admitAutomationExecution({
    automation: executionAutomation,
    trigger: params.trigger,
    idempotencyKey: params.idempotencyKey,
    dueAt: params.dueAt,
    adapterKind: 'legacy_task',
  });
  if (!admitted.created && TERMINAL_EXECUTION_STATUSES.has(admitted.execution.status)) {
    await assertAutomationRunProjected(admitted.automationRunId, admitted.execution.id, admitted.execution.status);
    const success = admitted.execution.status === 'succeeded';
    const taskId = typeof admitted.execution.resultJson?.taskId === 'string' ? admitted.execution.resultJson.taskId : null;
    return {
      executionId: admitted.execution.id,
      automationRunId: admitted.automationRunId,
      sessionId: admitted.execution.sessionId,
      executionStatus: admitted.execution.status,
      replayedOccurrence: true,
      result: {
        status: success ? (admitted.execution.resultJson?.automationOutcome === 'none' ? 'none' : 'success') : admitted.execution.status === 'timed_out' ? 'timeout' : 'failed',
        resultId: admitted.execution.sessionId || taskId,
        summaryText: admitted.execution.summaryText,
        error: success ? null : String(admitted.execution.errorJson?.message || `Execution ended with status ${admitted.execution.status}`),
        errorJson: { ...(admitted.execution.errorJson || {}), executionId: admitted.execution.id, executionPath: 'execution_control_plane', replayedOccurrence: true },
        runnerKind: 'ai',
        runnerRef: admitted.execution.executorRef,
      },
    };
  }
  if (!admitted.created && admitted.execution.status !== 'admitted') {
    throw new Error(`scheduled occurrence already has non-terminal execution ${admitted.execution.id} in status ${admitted.execution.status}`);
  }
  try {
    await transitionExecution({
      executionId: admitted.execution.id,
      expectedStatuses: ['admitted'],
      toStatus: 'running',
      eventType: 'execution_started',
      actorType: 'system',
      payload: { executionPath: 'execution_control_plane', trigger: params.trigger, dueAt: params.dueAt || null },
    });
  } catch (error) {
    // A duplicate caller may have observed the same admitted occurrence and lost
    // the compare-and-set race to the real runner. Never mutate that runner's
    // state from the losing caller.
    if (admitted.created) {
      await recoverExecutionFailure({ executionId: admitted.execution.id, phase: 'starting', error });
    }
    throw error;
  }

  const automation = executionAutomation;
  const prompt = automation.prompt || String((automation.definitionJson as any).prompt || automation.description || automation.name);
  let receipt: Awaited<ReturnType<typeof executeWithLegacyTaskAdapter>>;
  try {
    receipt = await executeWithLegacyTaskAdapter({
      execution: { ...admitted.execution, status: 'running' }, title: automation.name, prompt,
      cwd: await resolveAutomationAiCwd(automation), userId: automation.userId, model: automation.model,
      workflow: (automation.workflow || 'default') as any, broadcast: params.broadcast,
    });
  } catch (error) {
    await recoverExecutionFailure({ executionId: admitted.execution.id, phase: 'adapter', error });
    throw error;
  }

  let settled: Awaited<ReturnType<typeof settleExecution>>;
  try {
    settled = await settleExecution(admitted.execution.id, receipt);
  } catch (error) {
    await recoverExecutionFailure({ executionId: admitted.execution.id, phase: 'reconcile', error, executorRef: receipt.executorRef, sessionId: receipt.sessionId });
    throw error;
  }
  const finishedAt = new Date().toISOString();
  try {
    await projectAutomationExecutionResult({
      automationRunId: admitted.automationRunId, execution: settled.execution, receipt,
      durationMs: Date.now() - start, startedAt, finishedAt, executionPath: 'execution_control_plane',
    });
  } catch (error) {
    await recoverExecutionFailure({ executionId: admitted.execution.id, phase: 'projection', error, executorRef: receipt.executorRef, sessionId: receipt.sessionId });
    throw error;
  }

  const success = settled.execution.status === 'succeeded';
  return {
    executionId: settled.execution.id,
    automationRunId: admitted.automationRunId,
    sessionId: receipt.sessionId,
    executionStatus: settled.execution.status,
    replayedOccurrence: false,
    result: {
      status: success ? (receipt.resultJson.automationOutcome === 'none' ? 'none' : 'success') : settled.execution.status === 'timed_out' ? 'timeout' : 'failed',
      resultId: receipt.sessionId || receipt.taskId,
      summaryText: receipt.summaryText,
      error: success ? null : String(receipt.errorJson?.message || `Execution ended with status ${settled.execution.status}`),
      errorJson: { ...(receipt.errorJson || {}), executionId: settled.execution.id, executionPath: 'execution_control_plane' },
      runnerKind: 'ai', runnerRef: receipt.executorRef,
    },
  };
}
