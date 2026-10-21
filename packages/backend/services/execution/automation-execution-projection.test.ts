import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../db/pg-repo.js', () => ({ execute: vi.fn(), queryOne: vi.fn() }));
import { execute, queryOne } from '../../db/pg-repo.js';
import { assertAutomationRunProjected, projectAutomationExecutionResult } from './automation-execution-projection.js';

const result = {
  automationRunId: 'run-1', execution: { id: 'execution-1', status: 'succeeded' },
  receipt: { outcome: 'succeeded', taskId: 'task-1', sessionId: 'session-1', executorRef: 'task:task-1', errorJson: null },
  durationMs: 500, startedAt: '2026-09-22T00:00:00Z', finishedAt: '2026-09-22T00:00:01Z', executionPath: 'execution_control_plane',
} as any;

beforeEach(() => vi.clearAllMocks());
describe('Automation Run projection barrier', () => {
  it('rejects an update that did not write its exact Run/Execution pair', async () => {
    vi.mocked(execute).mockResolvedValue({ changes: 0 });
    await expect(projectAutomationExecutionResult(result)).rejects.toThrow('projection not written');
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1 AND execution_id = $11'), expect.arrayContaining(['run-1', 'execution-1']));
  });
  it('accepts exactly one persisted projection update', async () => {
    vi.mocked(execute).mockResolvedValue({ changes: 1 });
    await expect(projectAutomationExecutionResult(result)).resolves.toBeUndefined();
  });
  it.each([
    undefined,
    { status: 'admitted', finished_at: null, execution_status: null },
    { status: 'success', finished_at: null, execution_status: 'succeeded' },
    { status: 'success', finished_at: new Date(), execution_status: null },
    { status: 'success', finished_at: new Date(), execution_status: 'failed' },
  ])('does not treat an incomplete terminal Run as completed: %j', async row => {
    vi.mocked(queryOne).mockResolvedValue(row as any);
    await expect(assertAutomationRunProjected('run-1', 'execution-1', 'succeeded')).rejects.toThrow('projection incomplete');
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1 AND execution_id = $2'), ['run-1', 'execution-1']);
  });
  it.each([
    ['succeeded', 'success'], ['failed', 'failed'], ['uncertain', 'failed'], ['timed_out', 'timeout'],
  ])('accepts a matching %s projection', async (executionStatus, status) => {
    vi.mocked(queryOne).mockResolvedValue({ status, finished_at: new Date(), execution_status: executionStatus });
    await expect(assertAutomationRunProjected('run-1', 'execution-1', executionStatus as any)).resolves.toBeUndefined();
  });
});
