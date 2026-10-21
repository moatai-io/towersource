import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), projects: vi.fn(), session: vi.fn(), readiness: vi.fn(), receiptsReady: vi.fn(), job: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ query: m.query, queryOne: m.queryOne }));
vi.mock('../execution/execution-readiness.js', () => ({ getExecutionControlPlaneReadiness: m.readiness }));
vi.mock('../pm/project-membership-manager.js', () => ({ getAccessibleProjectIds: m.projects }));
vi.mock('../pm/project-access.js', () => ({ canAccessSession: m.session }));
vi.mock('./automation-result-receipts.js', () => ({ automationResultReceiptsReady: m.receiptsReady }));
vi.mock('./schedule-permissions.js', () => ({ canAccessAutomationJob: m.job }));
import { listAutomationResults, sanitizeAutomationRunEvidence } from './automation-results.js';

const run = (overrides: Record<string, unknown> = {}) => ({
  id: 'run-1', automation_id: 'job-1', automation_name: 'Morning report', project_id: 'project-a',
  job_type: 'ai_prompt', automation_user_id: 7, status: 'admitted', mode: 'spawn', result_id: null, error: null,
  duration_ms: null, ran_at: '2026-09-01T00:00:00Z', trigger: 'schedule',
  started_at: null, finished_at: null, stdout_text: null, stderr_text: null,
  summary_text: null, error_json: null, runner_kind: 'system', runner_ref: null,
  execution_status: 'running', execution_session_id: null, ...overrides,
});
const input = { userId: 7, role: 'member', projectId: 'project-a', limit: 20 };

beforeEach(() => {
  vi.clearAllMocks(); m.projects.mockResolvedValue(['project-a']); m.query.mockResolvedValue([]);
  m.session.mockResolvedValue({ allowed: true }); m.queryOne.mockResolvedValue(undefined);
  m.readiness.mockResolvedValue({ ready: true, missing: [] }); m.receiptsReady.mockResolvedValue(false); m.job.mockResolvedValue({ allowed: true });
});

describe('project-scoped Automation Run results', () => {
  it('rejects inaccessible projects before any run contents are queried', async () => {
    m.projects.mockResolvedValue(['project-b']);
    await expect(listAutomationResults(input)).rejects.toMatchObject({ status: 403 });
    expect(m.query).not.toHaveBeenCalled();
  });

  it.each(['admin', 'operator'])('allows %s read of scoped results', async role => {
    m.projects.mockResolvedValue(null); m.query.mockResolvedValue([run()]);
    expect((await listAutomationResults({ ...input, role })).items).toHaveLength(1);
  });

  it('limits latest runs inside the project and keeps execution state distinct from legacy status', async () => {
    m.query.mockResolvedValue([
      run({ id: 'uncertain', status: 'admitted', execution_status: 'uncertain', error: 'still pending' }),
      run({ id: 'timed-out', status: 'failed', execution_status: 'timed_out' }),
      run({ id: 'failed', status: 'failed', execution_status: 'failed' }),
      run({ id: 'legacy', status: 'spawned', execution_status: null }),
    ]);
    const { items } = await listAutomationResults({ ...input, limit: 4 });
    expect(items.map(x => [x.run.id, x.run.status, x.executionStatus])).toEqual([
      ['uncertain', 'admitted', 'uncertain'], ['timed-out', 'failed', 'timed_out'],
      ['failed', 'failed', 'failed'], ['legacy', 'spawned', undefined],
    ]);
    const [sql, args] = m.query.mock.calls[0];
    expect(sql).toContain('WHERE a.project_id = $1');
    expect(sql.indexOf('WHERE a.project_id = $1')).toBeLessThan(sql.indexOf('LIMIT $2'));
    expect(sql).toContain('e.source_id = a.id');
    expect(sql).toContain('e.project_id = a.project_id');
    expect(args).toEqual(['project-a', 4]);
  });

  it('projects user-local receipts only when the additive schema is ready', async () => {
    m.receiptsReady.mockResolvedValueOnce(true);
    m.query.mockResolvedValue([run({ receipt_read_at: '2026-09-02', receipt_actioned_at: null })]);
    const result = await listAutomationResults(input);
    expect(result.receiptStateAvailable).toBe(true);
    expect(result.items[0].receipt).toEqual({ readAt: '2026-09-02', actionedAt: null });
    expect(m.query.mock.calls[0][0]).toContain('rr.user_id = $3');
    expect(m.query.mock.calls[0][1]).toEqual(['project-a', 20, 7]);
    m.receiptsReady.mockResolvedValueOnce(false);
    expect((await listAutomationResults(input)).items[0].receipt).toBeUndefined();
    expect(m.query.mock.calls[1][0]).not.toContain('automation_result_receipts rr');
  });
  it('links a verified session only after session access, not a polymorphic task ID', async () => {
    m.query.mockResolvedValue([
      run({ id: 'task', status: 'success', result_id: 'task-1', runner_kind: 'ai', runner_ref: 'completed-task:task-1' }),
      run({ id: 'session', status: 'success', result_id: 'task-2', runner_kind: 'ai', runner_ref: 'completed-session:session-1' }),
      run({ id: 'execution', execution_status: 'succeeded', execution_session_id: 'session-2' }),
    ]);
    const { items } = await listAutomationResults(input);
    expect(items.map(x => x.sessionId)).toEqual([null, 'session-1', 'session-2']);
    expect(m.session.mock.calls).toEqual([['session-1', 7, 'member'], ['session-2', 7, 'member']]);
    expect(m.queryOne).toHaveBeenCalledWith(expect.stringContaining('FROM tasks'), ['task-1', 'project-a']);
  });

  it('redacts private session evidence while retaining result status and timestamps', async () => {
    m.query.mockResolvedValue([run({ status: 'failed', execution_status: 'cancelled',
      result_id: 'session-private', mode: 'inject', runner_kind: 'ai',
      error: 'private details', summary_text: 'private message', stdout_text: 'private stdout',
      stderr_text: 'private stderr', error_json: { private: 'value' }, runner_ref: 'session-private',
    })]);
    m.session.mockResolvedValue({ allowed: false });
    const { items } = await listAutomationResults(input);
    expect(items[0]).toMatchObject({ sessionId: null, executionStatus: 'cancelled', run: {
      status: 'failed', resultId: null, error: null, summaryText: null, stdoutText: null,
      stderrText: null, errorJson: null, runnerRef: null,
    } });
    expect(JSON.stringify(items)).not.toContain('private');
    m.session.mockRejectedValue(new Error('unavailable'));
    expect((await listAutomationResults(input)).items[0].run.resultId).toBeNull();
  });

  it('flags only unverified legacy AI spawn without changing persisted status', async () => {
    m.query.mockResolvedValue([
      run({ id: 'dispatch', status: 'success', runner_kind: 'ai', result_id: 'task-1', execution_status: null }),
      run({ id: 'spawn', status: 'spawned', runner_kind: 'ai', execution_status: null }),
      run({ id: 'terminal', status: 'success', runner_kind: 'ai', runner_ref: 'completed-session:session-1', execution_status: null }),
      run({ id: 'execution', status: 'success', runner_kind: 'ai', execution_status: 'succeeded' }),
    ]);
    const { items } = await listAutomationResults(input);
    expect(items.map(x => [x.run.status, x.outcomeUnverified])).toEqual([
      ['success', true], ['spawned', true], ['success', undefined], ['success', undefined],
    ]);
  });

  it('uses legacy SQL without missing execution table or column when schema is not ready', async () => {
    m.readiness.mockResolvedValue({ ready: false, missing: ['executions', 'automation_runs.execution_id'] });
    m.query.mockResolvedValue([run({ status: 'spawned', runner_kind: 'ai', execution_status: null })]);
    const { items } = await listAutomationResults(input);
    expect(items[0]).toMatchObject({ outcomeUnverified: true, run: { status: 'spawned' } });
    const sql = m.query.mock.calls[0][0];
    expect(sql).toContain('NULL::text AS execution_status');
    expect(sql).not.toContain('LEFT JOIN executions');
    expect(sql).not.toContain('r.execution_id');
  });

  it('resolves a task session only in the same project and redacts when Session ACL denies it', async () => {
    m.queryOne.mockResolvedValue({ session_id: 'private-session' }); m.session.mockResolvedValue({ allowed: false });
    const evidence = { mode: 'spawn', status: 'success', runnerKind: 'ai', runnerRef: 'task:task-1',
      resultId: 'task-1', error: 'private', stdoutText: null, stderrText: null,
      summaryText: 'private', errorJson: null };
    const result = await sanitizeAutomationRunEvidence(evidence,
      { mode: 'spawn', jobType: 'ai_prompt', projectId: 'project-a' }, 7, 'member');
    expect(m.queryOne).toHaveBeenCalledWith(expect.stringContaining('project_id IS NOT DISTINCT FROM'), ['task-1', 'project-a']);
    expect(m.session).toHaveBeenCalledWith('private-session', 7, 'member');
    expect(result).toMatchObject({ sessionId: null, run: { resultId: null, error: null, summaryText: null, runnerRef: null } });
    expect(evidence.resultId).toBe('task-1');
  });

  it('provides an ACL-approved task session link without rewriting task resultId', async () => {
    m.query.mockResolvedValue([run({ status: 'failed', runner_kind: 'ai', runner_ref: 'task:task-2', result_id: 'task-2', execution_session_id: null })]);
    m.queryOne.mockResolvedValue({ session_id: 'session-2' });
    const item = (await listAutomationResults(input)).items[0];
    expect(item).toMatchObject({ sessionId: 'session-2', run: { status: 'failed', resultId: 'task-2' } });
    expect(m.session).toHaveBeenCalledWith('session-2', 7, 'member');
  });

  it('fails closed when task evidence cannot be resolved', async () => {
    m.query.mockResolvedValue([run({ runner_kind: 'ai', runner_ref: 'task:task-2', result_id: 'task-2', summary_text: 'private evidence' })]);
    m.queryOne.mockRejectedValue(new Error('task store unavailable'));
    const item = (await listAutomationResults(input)).items[0];
    expect(item).toMatchObject({ sessionId: null, run: { resultId: null, summaryText: null, runnerRef: null } });
    expect(m.session).not.toHaveBeenCalled();
  });

  it('rechecks each job before emitting results', async () => {
    m.query.mockResolvedValue([run()]); m.job.mockResolvedValue({ allowed: false });
    expect((await listAutomationResults(input)).items).toEqual([]);
  });

  it('does not invent a session for a sessionless webhook result', async () => {
    m.query.mockResolvedValue([run({ job_type: 'webhook', result_id: 'external-id', runner_kind: 'webhook',
      summary_text: 'HTTP 200', execution_status: null })]);
    const { items } = await listAutomationResults(input);
    expect(items[0]).toMatchObject({ sessionId: null, run: { resultId: 'external-id', summaryText: 'HTTP 200' } });
    expect(m.session).not.toHaveBeenCalled();
  });
});
