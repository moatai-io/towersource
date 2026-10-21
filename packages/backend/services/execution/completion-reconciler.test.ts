import { describe, expect, it, vi } from 'vitest';
import { settleExecution } from './completion-reconciler.js';
import type { ExecutionRecord } from './execution-types.js';

function execution(status: ExecutionRecord['status'], overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: 'execution-1', sourceKind: 'automation', sourceId: 'automation-1', sourceRunId: 'run-1',
    scopeKind: 'system', projectId: null, actorUserId: 7, status, adapterKind: 'legacy_task',
    engine: null, model: null, sessionId: null, executorRef: null, parentExecutionId: null,
    attempt: 1, idempotencyKey: 'key-1', inputJson: {}, resultJson: null, summaryText: null,
    errorJson: null, admittedAt: null, startedAt: null, finishedAt: null,
    createdAt: 'now', updatedAt: 'now', ...overrides,
  };
}

const receipt = {
  adapterKind: 'legacy_task' as const, executorRef: 'task:task-1', taskId: 'task-1',
  sessionId: 'session-1', outcome: 'succeeded' as const, summaryText: 'done',
  resultJson: { taskId: 'task-1', taskStatus: 'done' }, errorJson: null,
};

describe('Completion Reconciler', () => {
  it('is the sole mapper from adapter receipt to terminal execution transition', async () => {
    const transition = vi.fn(async (input: any) => execution(input.toStatus, {
      executorRef: input.executorRef, sessionId: input.sessionId,
    }));
    const result = await settleExecution('execution-1', receipt, {
      getExecution: vi.fn(async () => execution('running')),
      transition: transition as any,
    });
    expect(result.settled).toBe(true);
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({
      expectedStatuses: ['running'], toStatus: 'succeeded', eventType: 'execution_succeeded',
      executorRef: 'task:task-1', sessionId: 'session-1',
    }));
  });

  it('treats the same terminal evidence as idempotent no-op', async () => {
    const current = execution('succeeded', { executorRef: 'task:task-1', sessionId: 'session-1' });
    const transition = vi.fn();
    const result = await settleExecution('execution-1', receipt, {
      getExecution: vi.fn(async () => current), transition: transition as any,
    });
    expect(result).toEqual({ execution: current, settled: false });
    expect(transition).not.toHaveBeenCalled();
  });

  it('refuses contradictory terminal evidence', async () => {
    await expect(settleExecution('execution-1', receipt, {
      getExecution: vi.fn(async () => execution('failed', { executorRef: 'task:task-1' })),
      transition: vi.fn() as any,
    })).rejects.toThrow('terminal conflict');
  });
});
