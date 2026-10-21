import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../process/process-map-manager.js', () => ({ appendProcessEvent: vi.fn(async () => undefined) }));
vi.mock('./automation-manager.js', () => ({
  getAutomation: vi.fn(),
  logRun: vi.fn(async () => 'run-1'),
  recordAutomationRuntimeResult: vi.fn(async () => undefined),
  updateAutomation: vi.fn(),
  deleteAutomation: vi.fn(async () => true),
}));
vi.mock('./automation-runners.js', () => ({
  resolveAutomationAiCwd: vi.fn(async () => '/workspace'),
  runAutomationJob: vi.fn(async () => ({ status: 'success', resultId: 'session-1', summaryText: 'done', runnerKind: 'ai' })),
}));
vi.mock('../notification-hub.js', () => ({ notifyExecutionReport: vi.fn(async () => 'notification-1') }));
vi.mock('./schedule-permissions.js', () => ({ canAccessAutomationJob: vi.fn(async () => ({ allowed: true })) }));
vi.mock('../execution/automation-execution-admission.js', () => ({ admitAutomationExecution: vi.fn() }));
vi.mock('../execution/execution-manager.js', () => ({ transitionExecution: vi.fn() }));
vi.mock('../execution/adapters/legacy-task-execution-adapter.js', () => ({ executeWithLegacyTaskAdapter: vi.fn() }));
vi.mock('../execution/completion-reconciler.js', () => ({ settleExecution: vi.fn() }));
vi.mock('../execution/automation-execution-projection.js', () => ({ projectAutomationExecutionResult: vi.fn(async () => undefined) }));
vi.mock('../execution/execution-readiness.js', () => ({ assertExecutionControlPlaneReady: vi.fn(async () => undefined) }));
vi.mock('../execution/execution-failure-recovery.js', () => ({ recoverExecutionFailure: vi.fn() }));

import { notifyExecutionReport } from '../notification-hub.js';
import { appendProcessEvent } from '../process/process-map-manager.js';
import { logRun, recordAutomationRuntimeResult, updateAutomation } from './automation-manager.js';
import { runAutomationJob } from './automation-runners.js';
import { runAutomationNow } from './automation-control.js';
import type { Automation } from './automation-manager.js';
import { admitAutomationExecution } from '../execution/automation-execution-admission.js';
import { transitionExecution } from '../execution/execution-manager.js';
import { executeWithLegacyTaskAdapter } from '../execution/adapters/legacy-task-execution-adapter.js';
import { settleExecution } from '../execution/completion-reconciler.js';
import { projectAutomationExecutionResult } from '../execution/automation-execution-projection.js';
import { assertExecutionControlPlaneReady } from '../execution/execution-readiness.js';
import { recoverExecutionFailure } from '../execution/execution-failure-recovery.js';

const automation = {
  id: 'a1', userId: 7, projectId: 'p1', name: 'briefing', mode: 'spawn', sessionId: null,
  jobType: 'ai_prompt', model: 'test-model', prompt: 'prepare briefing', workflow: 'auto', cwd: '/tmp/p1',
} as Automation;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('TOWER_AUTOMATION_EXECUTION_CONTROL_PLANE_ENABLED', 'false');
});

describe('runAutomationNow legacy path', () => {
  it('does not dispatch an unreviewed creation draft even through Run Now', async () => {
    await expect(runAutomationNow({ automation: { ...automation, definitionJson: { creationPlan: { status: 'draft' } } } as Automation, broadcast: vi.fn() })).rejects.toThrow('reviewed');
    expect(runAutomationJob).not.toHaveBeenCalled();
    expect(logRun).not.toHaveBeenCalled();
  });
  it('persists a normal none result without a completion or failure notification', async () => {
    vi.mocked(runAutomationJob).mockResolvedValueOnce({ status: 'none', resultId: null, summaryText: 'No work', runnerKind: 'ai' });
    const result = await runAutomationNow({ automation });
    expect(result.status).toBe('none');
    expect(logRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'none' }));
    expect(notifyExecutionReport).not.toHaveBeenCalled();
  });

  it('records admission without a false completion notification or task-as-session link', async () => {
    vi.mocked(runAutomationJob).mockResolvedValueOnce({ status: 'spawned', resultId: 'task-1', runnerKind: 'ai' });
    await runAutomationNow({ automation, broadcast: vi.fn() });
    expect(appendProcessEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'step_started', sessionId: null,
      rawPayload: expect.objectContaining({ executionPath: 'legacy', featureFlagState: 'off' }),
    }));
    expect(notifyExecutionReport).not.toHaveBeenCalled();
    expect(logRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'spawned', resultId: 'task-1' }));
  });

  it('uses the runner and records the same run ledger and process event contract', async () => {
    const broadcast = vi.fn();
    const result = await runAutomationNow({ automation, broadcast });
    expect(runAutomationJob).toHaveBeenCalledWith(automation, broadcast);
    expect(logRun).toHaveBeenCalledWith(expect.objectContaining({ automationId: 'a1', trigger: 'manual', status: 'success' }));
    expect(recordAutomationRuntimeResult).toHaveBeenCalledWith('a1', 'success', null);
    expect(appendProcessEvent).toHaveBeenCalledWith(expect.objectContaining({
      automationId: 'a1', runId: 'run-1', sourceType: 'automation_run', eventType: 'step_completed',
      rawPayload: expect.objectContaining({ executionPath: 'legacy', executionPathReason: 'disabled' }),
    }));
    expect(result).toMatchObject({ runId: 'run-1', status: 'success', resultId: 'session-1' });
  });

  it('keeps unsupported modes on legacy path and records why even when the flag is on', async () => {
    vi.stubEnv('TOWER_AUTOMATION_EXECUTION_CONTROL_PLANE_ENABLED', 'true');
    await runAutomationNow({ automation: { ...automation, mode: 'inject' } });
    expect(runAutomationJob).toHaveBeenCalled();
    expect(appendProcessEvent).toHaveBeenCalledWith(expect.objectContaining({
      rawPayload: expect.objectContaining({ executionPath: 'legacy', executionPathReason: 'unsupported_job_or_mode', featureFlagState: 'on' }),
    }));
  });
});

describe('runAutomationNow Execution Control Plane path', () => {
  it('routes eligible AI spawn through the observable new path when explicitly enabled', async () => {
    vi.stubEnv('TOWER_AUTOMATION_EXECUTION_CONTROL_PLANE_ENABLED', 'true');
    const execution = { id: 'execution-1', status: 'admitted' } as any;
    vi.mocked(admitAutomationExecution).mockResolvedValue({ execution, automationRunId: 'run-ecp', created: true });
    vi.mocked(transitionExecution).mockResolvedValue({ ...execution, status: 'running' });
    vi.mocked(executeWithLegacyTaskAdapter).mockResolvedValue({
      adapterKind: 'legacy_task', executorRef: 'task:task-1', taskId: 'task-1', sessionId: 'session-1',
      outcome: 'succeeded', summaryText: 'done', resultJson: { taskId: 'task-1' }, errorJson: null,
    });
    vi.mocked(settleExecution).mockResolvedValue({ execution: { ...execution, status: 'succeeded' }, settled: true } as any);

    const result = await runAutomationNow({ automation, broadcast: vi.fn() });

    expect(assertExecutionControlPlaneReady).toHaveBeenCalledOnce();
    expect(runAutomationJob).not.toHaveBeenCalled();
    expect(admitAutomationExecution).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'manual', adapterKind: 'legacy_task' }));
    expect(transitionExecution).toHaveBeenCalledWith(expect.objectContaining({ toStatus: 'running', eventType: 'execution_started' }));
    expect(projectAutomationExecutionResult).toHaveBeenCalledWith(expect.objectContaining({ automationRunId: 'run-ecp', executionPath: 'execution_control_plane' }));
    expect(appendProcessEvent).toHaveBeenCalledWith(expect.objectContaining({
      executionId: 'execution-1', rawPayload: expect.objectContaining({ executionPath: 'execution_control_plane' }),
    }));
    expect(notifyExecutionReport).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ executionId: 'execution-1', executionPath: 'execution_control_plane' }),
    }));
    expect(result).toMatchObject({ runId: 'run-ecp', status: 'success', resultId: 'session-1' });
  });

  it('fails before admission when the schema is not ready', async () => {
    vi.stubEnv('TOWER_AUTOMATION_EXECUTION_CONTROL_PLANE_ENABLED', 'true');
    vi.mocked(assertExecutionControlPlaneReady).mockRejectedValueOnce(new Error('schema is not ready'));
    await expect(runAutomationNow({ automation, broadcast: vi.fn() })).rejects.toThrow('schema is not ready');
    expect(admitAutomationExecution).not.toHaveBeenCalled();
    expect(runAutomationJob).not.toHaveBeenCalled();
  });

  it('recovers adapter exceptions as uncertain instead of leaving a running execution', async () => {
    vi.stubEnv('TOWER_AUTOMATION_EXECUTION_CONTROL_PLANE_ENABLED', 'true');
    const execution = { id: 'execution-1', status: 'admitted' } as any;
    vi.mocked(admitAutomationExecution).mockResolvedValue({ execution, automationRunId: 'run-ecp', created: true });
    vi.mocked(transitionExecution).mockResolvedValue({ ...execution, status: 'running' });
    vi.mocked(executeWithLegacyTaskAdapter).mockRejectedValueOnce(new Error('adapter exploded'));
    vi.mocked(recoverExecutionFailure).mockResolvedValue({ ...execution, status: 'uncertain' });

    await expect(runAutomationNow({ automation, broadcast: vi.fn() })).rejects.toThrow('adapter exploded');
    expect(recoverExecutionFailure).toHaveBeenCalledWith(expect.objectContaining({
      executionId: 'execution-1', phase: 'adapter', error: expect.any(Error),
    }));
  });
});

describe('manual execution failure and one-shot safety', () => {
  it('records runner exceptions as failures', async () => {
    vi.mocked(runAutomationJob).mockRejectedValueOnce(new Error('runner unavailable'));
    const result = await runAutomationNow({ automation });
    expect(result.status).toBe('failed');
    expect(logRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error: 'runner unavailable' }));
  });
  it('consumes an executed one-shot', async () => {
    await runAutomationNow({ automation: { ...automation, triggerType: 'once' } });
    expect(updateAutomation).toHaveBeenCalledWith('a1', { enabled: false });
  });
  it('does not consume or notify on lock contention', async () => {
    vi.mocked(runAutomationJob).mockResolvedValueOnce({ status: 'skipped', resultId: null, runnerKind: 'system' });
    await runAutomationNow({ automation: { ...automation, triggerType: 'once' } });
    expect(updateAutomation).not.toHaveBeenCalled();
    expect(logRun).not.toHaveBeenCalled();
    expect(notifyExecutionReport).not.toHaveBeenCalled();
  });
});
