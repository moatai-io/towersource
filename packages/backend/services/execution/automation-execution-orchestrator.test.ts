import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../task/automation-runners.js', () => ({ resolveAutomationAiCwd: vi.fn(async () => '/resolved-project') }));
vi.mock('./execution-readiness.js', () => ({ assertExecutionControlPlaneReady: vi.fn(async () => undefined) }));
vi.mock('./automation-execution-projection.js', () => ({
  projectAutomationExecutionResult: vi.fn(async () => undefined),
  assertAutomationRunProjected: vi.fn(async () => undefined),
}));
vi.mock('./automation-execution-admission.js', () => ({ admitAutomationExecution: vi.fn() }));
vi.mock('./execution-manager.js', () => ({ transitionExecution: vi.fn() }));
vi.mock('./adapters/legacy-task-execution-adapter.js', () => ({ executeWithLegacyTaskAdapter: vi.fn() }));
vi.mock('./completion-reconciler.js', () => ({ settleExecution: vi.fn() }));
vi.mock('./execution-failure-recovery.js', () => ({ recoverExecutionFailure: vi.fn() }));

import { resolveAutomationAiCwd } from '../task/automation-runners.js';
import { admitAutomationExecution } from './automation-execution-admission.js';
import { transitionExecution } from './execution-manager.js';
import { executeWithLegacyTaskAdapter } from './adapters/legacy-task-execution-adapter.js';
import { settleExecution } from './completion-reconciler.js';
import { recoverExecutionFailure } from './execution-failure-recovery.js';
import { assertAutomationRunProjected, projectAutomationExecutionResult } from './automation-execution-projection.js';
import { executeAutomationViaExecutionControlPlane } from './automation-execution-orchestrator.js';
import { getModelDefaults } from '../../config.js';

const automation = {
  id: 'automation-1', userId: 7, projectId: null, scopeType: 'system', name: 'Scheduled brief',
  prompt: 'brief', model: 'test', workflow: 'auto', mode: 'spawn', jobType: 'ai_prompt', cwd: '/tmp',
} as any;

beforeEach(() => vi.clearAllMocks());

describe('shared Automation Execution orchestrator', () => {
  it('resolves Core before admission and passes the same model to the Task adapter', async () => {
    const admitted = { id: 'execution-core', status: 'admitted' } as any;
    vi.mocked(admitAutomationExecution).mockResolvedValue({ execution: admitted, automationRunId: 'run-core', created: true });
    vi.mocked(transitionExecution).mockResolvedValue({ ...admitted, status: 'running' });
    vi.mocked(executeWithLegacyTaskAdapter).mockResolvedValue({ adapterKind: 'legacy_task', outcome: 'succeeded', resultJson: {}, errorJson: null } as any);
    vi.mocked(settleExecution).mockResolvedValue({ execution: { ...admitted, status: 'succeeded' }, settled: true } as any);
    await executeAutomationViaExecutionControlPlane({ automation: { ...automation, model: 'preset/core' }, trigger: 'schedule', idempotencyKey: 'core-run', broadcast: vi.fn() });
    expect(admitAutomationExecution).toHaveBeenCalledWith(expect.objectContaining({ automation: expect.objectContaining({ model: getModelDefaults().session }) }));
    expect(resolveAutomationAiCwd).toHaveBeenCalledWith(expect.objectContaining({ id: automation.id }));
    expect(executeWithLegacyTaskAdapter).toHaveBeenCalledWith(expect.objectContaining({ model: getModelDefaults().session, cwd: '/resolved-project' }));
  });
  it('preserves schedule occurrence identity and returns terminal projection references', async () => {
    const admitted = { id: 'execution-1', status: 'admitted' } as any;
    vi.mocked(admitAutomationExecution).mockResolvedValue({ execution: admitted, automationRunId: 'run-1', created: true });
    vi.mocked(transitionExecution).mockResolvedValue({ ...admitted, status: 'running' });
    vi.mocked(executeWithLegacyTaskAdapter).mockResolvedValue({
      adapterKind: 'legacy_task', executorRef: 'task:task-1', taskId: 'task-1', sessionId: 'session-1',
      outcome: 'succeeded', summaryText: 'done', resultJson: { taskId: 'task-1' }, errorJson: null,
    });
    vi.mocked(settleExecution).mockResolvedValue({ execution: { ...admitted, status: 'succeeded' }, settled: true } as any);

    const result = await executeAutomationViaExecutionControlPlane({
      automation, trigger: 'schedule', dueAt: '2026-09-22T09:00:00.000Z',
      idempotencyKey: 'automation:automation-1:schedule:2026-09-22T09:00:00.000Z', broadcast: vi.fn(),
    });
    expect(admitAutomationExecution).toHaveBeenCalledWith(expect.objectContaining({
      trigger: 'schedule', dueAt: '2026-09-22T09:00:00.000Z',
      idempotencyKey: 'automation:automation-1:schedule:2026-09-22T09:00:00.000Z',
    }));
    expect(result).toMatchObject({ executionId: 'execution-1', automationRunId: 'run-1', sessionId: 'session-1', executionStatus: 'succeeded', replayedOccurrence: false, result: { status: 'success' } });
  });

  it('reuses a terminal occurrence without spawning a second compatibility Task', async () => {
    const terminal = {
      id: 'execution-1', status: 'succeeded', sessionId: 'session-1', executorRef: 'task:task-1',
      resultJson: { taskId: 'task-1' }, summaryText: 'already done', errorJson: null,
    } as any;
    vi.mocked(admitAutomationExecution).mockResolvedValue({ execution: terminal, automationRunId: 'run-1', created: false });
    const result = await executeAutomationViaExecutionControlPlane({
      automation, trigger: 'schedule', dueAt: '2026-09-22T09:00:00.000Z',
      idempotencyKey: 'automation:automation-1:schedule:2026-09-22T09:00:00.000Z', broadcast: vi.fn(),
    });
    expect(executeWithLegacyTaskAdapter).not.toHaveBeenCalled();
    expect(transitionExecution).not.toHaveBeenCalled();
    expect(result).toMatchObject({ replayedOccurrence: true, result: { status: 'success', resultId: 'session-1', errorJson: { replayedOccurrence: true } } });
  });

  it('does not consume a terminal replay when its Automation Run projection is missing', async () => {
    vi.mocked(admitAutomationExecution).mockResolvedValue({ execution: { id: 'execution-1', status: 'succeeded' } as any, automationRunId: 'run-1', created: false });
    vi.mocked(assertAutomationRunProjected).mockRejectedValueOnce(new Error('projection incomplete'));
    await expect(executeAutomationViaExecutionControlPlane({ automation, trigger: 'schedule', idempotencyKey: 'due', broadcast: vi.fn() }))
      .rejects.toThrow('projection incomplete');
    expect(executeWithLegacyTaskAdapter).not.toHaveBeenCalled();
    expect(transitionExecution).not.toHaveBeenCalled();
  });

  it('does not return success if the terminal projection update fails', async () => {
    const admitted = { id: 'execution-1', status: 'admitted' } as any;
    vi.mocked(admitAutomationExecution).mockResolvedValue({ execution: admitted, automationRunId: 'run-1', created: true });
    vi.mocked(transitionExecution).mockResolvedValue({ ...admitted, status: 'running' });
    vi.mocked(executeWithLegacyTaskAdapter).mockResolvedValue({ adapterKind: 'legacy_task', outcome: 'succeeded', resultJson: {}, errorJson: null } as any);
    vi.mocked(settleExecution).mockResolvedValue({ execution: { ...admitted, status: 'succeeded' }, settled: true } as any);
    vi.mocked(projectAutomationExecutionResult).mockRejectedValueOnce(new Error('projection update lost'));
    await expect(executeAutomationViaExecutionControlPlane({ automation, trigger: 'schedule', idempotencyKey: 'due', broadcast: vi.fn() }))
      .rejects.toThrow('projection update lost');
    expect(recoverExecutionFailure).toHaveBeenCalledWith(expect.objectContaining({ phase: 'projection' }));
  });

  it('does not let a losing duplicate claim mutate the real runner state', async () => {
    vi.mocked(admitAutomationExecution).mockResolvedValue({ execution: { id: 'execution-1', status: 'admitted' } as any, automationRunId: 'run-1', created: false });
    vi.mocked(transitionExecution).mockRejectedValueOnce(new Error('compare-and-set lost'));
    await expect(executeAutomationViaExecutionControlPlane({
      automation, trigger: 'schedule', dueAt: '2026-09-22T09:00:00.000Z',
      idempotencyKey: 'automation:automation-1:schedule:2026-09-22T09:00:00.000Z', broadcast: vi.fn(),
    })).rejects.toThrow('compare-and-set lost');
    expect(recoverExecutionFailure).not.toHaveBeenCalled();
  });

  it('refuses to duplicate a still-running occurrence after restart', async () => {
    vi.mocked(admitAutomationExecution).mockResolvedValue({ execution: { id: 'execution-1', status: 'running' } as any, automationRunId: 'run-1', created: false });
    await expect(executeAutomationViaExecutionControlPlane({
      automation, trigger: 'schedule', dueAt: '2026-09-22T09:00:00.000Z',
      idempotencyKey: 'automation:automation-1:schedule:2026-09-22T09:00:00.000Z', broadcast: vi.fn(),
    })).rejects.toThrow('already has non-terminal execution');
    expect(executeWithLegacyTaskAdapter).not.toHaveBeenCalled();
  });
});
