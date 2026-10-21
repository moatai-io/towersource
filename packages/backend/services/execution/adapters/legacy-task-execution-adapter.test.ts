import { describe, expect, it, vi } from 'vitest';
import { executeWithLegacyTaskAdapter } from './legacy-task-execution-adapter.js';
import type { ExecutionRecord } from '../execution-types.js';

const execution = {
  id: 'execution-1', sourceKind: 'automation', sourceId: 'automation-1', sourceRunId: 'run-1',
  scopeKind: 'system', projectId: null, actorUserId: 7, status: 'running', adapterKind: 'legacy_task',
  engine: null, model: 'test', sessionId: null, executorRef: null, parentExecutionId: null,
  attempt: 1, idempotencyKey: 'key-1', inputJson: {}, resultJson: null, summaryText: null,
  errorJson: null, admittedAt: null, startedAt: null, finishedAt: null,
  createdAt: 'now', updatedAt: 'now',
} as ExecutionRecord;

function task(status: 'todo' | 'in_progress' | 'done' | 'failed', sessionId: string | null = null) {
  return { id: 'task-1', status, sessionId, progressSummary: status === 'done' ? ['done'] : [] } as any;
}

const request = {
  execution, title: 'test', prompt: 'do it', cwd: '/tmp', userId: 7,
  model: 'test', workflow: 'auto' as any, broadcast: vi.fn(),
};

describe('Legacy Task Execution Adapter', () => {
  it('keeps system scope explicit and returns a successful terminal receipt', async () => {
    const createTask = vi.fn(async (...args: any[]) => task('todo'));
    const receipt = await executeWithLegacyTaskAdapter(request, {
      createTask: createTask as any,
      spawnTask: vi.fn(async () => undefined) as any,
      getTask: vi.fn(async () => task('done', 'session-1')) as any,
    });
    expect(createTask.mock.calls[0][8]).toBeNull();
    expect(createTask.mock.calls[0][10]).toBe('silent');
    expect(receipt).toMatchObject({ outcome: 'succeeded', executorRef: 'task:task-1', sessionId: 'session-1' });
  });

  it('preserves a real project id for project scope', async () => {
    const createTask = vi.fn(async () => task('todo'));
    await executeWithLegacyTaskAdapter({ ...request, execution: { ...execution, scopeKind: 'project', projectId: 'project-1' } }, {
      createTask: createTask as any,
      spawnTask: vi.fn(async () => undefined) as any,
      getTask: vi.fn(async () => task('failed')) as any,
    });
    expect(createTask.mock.calls[0][8]).toBe('project-1');
  });

  it('returns uncertain rather than retrying when spawn throws without persisted failure', async () => {
    const receipt = await executeWithLegacyTaskAdapter(request, {
      createTask: vi.fn(async () => task('todo')) as any,
      spawnTask: vi.fn(async () => { throw new Error('connection lost'); }) as any,
      getTask: vi.fn(async () => task('in_progress', 'session-1')) as any,
    });
    expect(receipt.outcome).toBe('uncertain');
    expect(receipt.errorJson).toMatchObject({ message: 'connection lost', retryable: false });
  });
});
