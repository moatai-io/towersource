import { describe, expect, it, vi } from 'vitest';
import { recoverExecutionFailure } from './execution-failure-recovery.js';
import type { ExecutionRecord } from './execution-types.js';

function execution(status: ExecutionRecord['status']): ExecutionRecord {
  return {
    id: 'execution-1', sourceKind: 'automation', sourceId: 'automation-1', sourceRunId: 'run-1',
    scopeKind: 'system', projectId: null, actorUserId: 7, status, adapterKind: 'legacy_task',
    engine: null, model: null, sessionId: null, executorRef: null, parentExecutionId: null,
    attempt: 1, idempotencyKey: 'key', inputJson: {}, resultJson: null, summaryText: null,
    errorJson: null, admittedAt: null, startedAt: null, finishedAt: null, createdAt: 'now', updatedAt: 'now',
  };
}

describe('Execution failure recovery', () => {
  it('marks pre-adapter starting failure as failed', async () => {
    const transition = vi.fn(async (input: any) => execution(input.toStatus));
    const result = await recoverExecutionFailure({ executionId: 'execution-1', phase: 'starting', error: new Error('start failed') }, {
      getExecution: vi.fn(async () => execution('admitted')), transition: transition as any,
    });
    expect(result.status).toBe('failed');
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ toStatus: 'failed', eventType: 'execution_failed' }));
  });

  it.each(['adapter', 'reconcile'] as const)('marks %s failure as uncertain because work may have started', async phase => {
    const transition = vi.fn(async (input: any) => execution(input.toStatus));
    const result = await recoverExecutionFailure({ executionId: 'execution-1', phase, error: new Error('lost evidence') }, {
      getExecution: vi.fn(async () => execution('running')), transition: transition as any,
    });
    expect(result.status).toBe('uncertain');
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ toStatus: 'uncertain', errorJson: expect.objectContaining({ phase, retryable: false }) }));
  });

  it('never overwrites terminal truth after projection failure', async () => {
    const current = execution('succeeded');
    const transition = vi.fn();
    await expect(recoverExecutionFailure({ executionId: 'execution-1', phase: 'projection', error: new Error('projection failed') }, {
      getExecution: vi.fn(async () => current), transition: transition as any,
    })).resolves.toBe(current);
    expect(transition).not.toHaveBeenCalled();
  });
});
