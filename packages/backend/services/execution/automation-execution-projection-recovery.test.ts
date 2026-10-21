import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn(), execute: vi.fn() }));
import { execute, query } from '../../db/pg-repo.js';
import {
  listRecoverableAutomationProjections,
  recoverAutomationExecutionProjection,
  recoverAutomationExecutionProjections,
} from './automation-execution-projection-recovery.js';

const candidate = {
  automationRunId: 'run-1', executionId: 'execution-1', executionStatus: 'succeeded' as const,
  sessionId: 'session-1', executorRef: 'task:task-1', resultJson: { taskId: 'task-1' },
  summaryText: 'done', errorJson: null, startedAt: '2026-09-22T00:00:00Z', finishedAt: '2026-09-22T00:00:05Z',
};

describe('Automation Execution projection recovery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('finds only terminal Executions with incomplete or contradictory projections', async () => {
    vi.mocked(query).mockResolvedValue([{
      automation_run_id: 'run-1', execution_id: 'execution-1', execution_status: 'succeeded',
      session_id: 'session-1', executor_ref: 'task:task-1', result_json: { taskId: 'task-1' },
      summary_text: 'done', error_json: null, started_at: 'start', finished_at: 'finish',
    }]);
    const result = await listRecoverableAutomationProjections(9999);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("e.status IN ('succeeded','failed','cancelled','timed_out','uncertain')"), [500]);
    expect(result[0]).toMatchObject({ executionId: 'execution-1', automationRunId: 'run-1' });
  });

  it('replays a terminal projection with compare-and-set guards and recovery provenance', async () => {
    vi.mocked(execute).mockResolvedValue({ changes: 1 });
    const result = await recoverAutomationExecutionProjection(candidate);
    expect(result).toEqual({ recovered: true, reason: 'updated' });
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("status IN ('queued','admitted','starting','running')"), expect.arrayContaining([
      'run-1', 'execution-1', 'success', 'session-1', expect.anything(), 'succeeded',
    ]));
    const params = vi.mocked(execute).mock.calls[0][1]!;
    expect(params.some(value => typeof value === 'string' && value.includes('"projectionRecovered":true'))).toBe(true);
  });

  it('is idempotent when another projector already completed the row', async () => {
    vi.mocked(execute).mockResolvedValue({ changes: 0 });
    await expect(recoverAutomationExecutionProjection(candidate)).resolves.toEqual({ recovered: false, reason: 'already_projected' });
  });

  it('refuses non-terminal candidates even if supplied directly', async () => {
    await expect(recoverAutomationExecutionProjection({ ...candidate, executionStatus: 'running' }))
      .resolves.toEqual({ recovered: false, reason: 'not_terminal' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns a bounded recovery summary', async () => {
    vi.mocked(query).mockResolvedValue([
      { automation_run_id: 'run-1', execution_id: 'execution-1', execution_status: 'succeeded', result_json: {}, error_json: null },
      { automation_run_id: 'run-2', execution_id: 'execution-2', execution_status: 'failed', result_json: {}, error_json: { message: 'failed' } },
    ]);
    vi.mocked(execute).mockResolvedValueOnce({ changes: 1 }).mockResolvedValueOnce({ changes: 0 });
    await expect(recoverAutomationExecutionProjections(10)).resolves.toEqual({ examined: 2, recovered: 1, skipped: 1 });
  });
});
