import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), getAutomation: vi.fn(), advance: vi.fn(), log: vi.fn(), execute: vi.fn(), runner: vi.fn(), notify: vi.fn(), event: vi.fn(), existing: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ query: mocks.query }));
vi.mock('./scheduler-ownership.js', () => ({ scheduledExecutionEnabled: () => true, withSchedulerTickLock: async (fn: () => unknown) => fn() }));
vi.mock('./automation-manager.js', () => ({ getAutomation: mocks.getAutomation, advanceSchedule: mocks.advance, logRun: mocks.log }));
vi.mock('./automation-runners.js', () => ({ runAutomationJob: mocks.runner }));
vi.mock('../execution/scheduled-occurrence-lookup.js', () => ({ hasScheduledAutomationExecution: mocks.existing }));
vi.mock('../execution/automation-execution-orchestrator.js', () => ({ executeAutomationViaExecutionControlPlane: mocks.execute }));
vi.mock('../notification-hub.js', () => ({ notifyExecutionReport: mocks.notify }));
vi.mock('../process/process-map-manager.js', () => ({ appendProcessEvent: mocks.event }));

import { startUnifiedScheduler, stopUnifiedScheduler } from './unified-scheduler.js';
const dueAt = '2026-09-22T09:00:00.000Z';
const automation = { id: 'occurrence-test', userId: 7, projectId: null, scopeType: 'system', name: 'Test', prompt: 'brief', jobType: 'ai_prompt', mode: 'spawn', enabled: true, status: 'idle', triggerType: 'once', nextRunAt: dueAt, definitionJson: {} };

beforeEach(() => {
  vi.resetAllMocks();
  vi.setSystemTime(new Date('2026-09-22T09:30:00.000Z'));
  vi.stubEnv('TOWER_AUTOMATION_EXECUTION_CONTROL_PLANE_ENABLED', 'true');
  mocks.query.mockResolvedValue([{ id: automation.id, severity: 'L2' }]);
  mocks.getAutomation.mockResolvedValue(automation);
  mocks.log.mockResolvedValue('legacy-run-1');
  mocks.existing.mockResolvedValue(false);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { stopUnifiedScheduler(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function tick() {
  startUnifiedScheduler(vi.fn());
  await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(mocks.advance.mock.calls.length + vi.mocked(console.error).mock.calls.length).toBeGreaterThan(0));
}

describe('scheduled occurrence preservation with isolated dependencies', () => {
  it('advances a none occurrence normally without an alert', async () => {
    mocks.execute.mockResolvedValueOnce({ result: { status: 'none', resultId: null, summaryText: 'No work' }, automationRunId: 'run-none', executionId: 'exec-none', executionStatus: 'succeeded' });
    await tick();
    expect(mocks.advance).toHaveBeenCalledWith(automation, 'none', null);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('reports a terminal occurrence once with canonical Run and Execution identity', async () => {
    mocks.execute.mockResolvedValueOnce({ result: { status: 'success', resultId: 'task-1', summaryText: 'done' }, automationRunId: 'run-1', executionId: 'exec-1', sessionId: 'session-1', executionStatus: 'succeeded' });
    await tick();
    await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalledTimes(1));
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'automation', sessionId: 'session-1', metadata: expect.objectContaining({ automationId: automation.id, runId: 'run-1', executionId: 'exec-1' }) }));
    expect(mocks.log).not.toHaveBeenCalled();
  });
  it.each(['schema is not ready', 'scheduled occurrence already has non-terminal execution', 'compare-and-set lost', 'projection unavailable'])('preserves dueAt when orchestrator throws: %s', async message => {
    mocks.execute.mockRejectedValueOnce(new Error(message));
    await tick();
    expect(mocks.advance).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
    expect(mocks.runner).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('advances a terminal replay without creating a second run or notification', async () => {
    mocks.execute.mockResolvedValueOnce({ result: { status: 'success' }, replayedOccurrence: true, executionStatus: 'succeeded' });
    await tick();
    expect(mocks.advance).toHaveBeenCalledWith(automation, 'success', null);
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ dueAt, idempotencyKey: `automation:${automation.id}:schedule:${dueAt}` }));
    expect(mocks.runner).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it.each(['running', 'succeeded', 'uncertain'])('rechecks an overdue daily cron with an existing %s execution', async status => {
    const cron = { ...automation, triggerType: 'cron', cronConfig: { type: 'daily', hour: 9, minute: 0 } };
    mocks.getAutomation.mockResolvedValue(cron);
    mocks.existing.mockResolvedValue(true);
    if (status === 'running') mocks.execute.mockRejectedValue(new Error('non-terminal execution'));
    else mocks.execute.mockResolvedValue({ result: { status: status === 'succeeded' ? 'success' : 'failed' }, executionStatus: status, replayedOccurrence: true });
    await tick();
    expect(mocks.existing).toHaveBeenCalledWith(cron.id, dueAt);
    expect(mocks.log).not.toHaveBeenCalled();
    expect(mocks.runner).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
    if (status === 'running') expect(mocks.advance).not.toHaveBeenCalled();
    else expect(mocks.advance).toHaveBeenCalledOnce();
  });

  it('skips a never-admitted overdue cron under the existing policy', async () => {
    mocks.getAutomation.mockResolvedValue({ ...automation, triggerType: 'cron', cronConfig: { type: 'daily' } });
    startUnifiedScheduler(vi.fn());
    await vi.waitFor(() => expect(mocks.advance).toHaveBeenCalledWith(expect.anything(), 'skipped', expect.any(String)));
    expect(mocks.existing).toHaveBeenCalledWith(automation.id, dueAt);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
  });

  it('preserves an overdue cron if the occurrence lookup is unavailable', async () => {
    mocks.getAutomation.mockResolvedValue({ ...automation, triggerType: 'cron', cronConfig: { type: 'daily' } });
    mocks.existing.mockRejectedValue(new Error('schema unavailable'));
    startUnifiedScheduler(vi.fn());
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(mocks.existing).toHaveBeenCalledOnce();
    expect(mocks.advance).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('retains the legacy overdue cron skip without querying the new ledger', async () => {
    vi.stubEnv('TOWER_AUTOMATION_EXECUTION_CONTROL_PLANE_ENABLED', 'false');
    mocks.getAutomation.mockResolvedValue({ ...automation, triggerType: 'cron', cronConfig: { type: 'daily' } });
    startUnifiedScheduler(vi.fn());
    await vi.waitFor(() => expect(mocks.advance).toHaveBeenCalledWith(expect.anything(), 'skipped', expect.any(String)));
    expect(mocks.existing).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('retains legacy failure advancement when the feature flag is off', async () => {
    vi.stubEnv('TOWER_AUTOMATION_EXECUTION_CONTROL_PLANE_ENABLED', 'false');
    mocks.runner.mockRejectedValueOnce(new Error('legacy failure'));
    startUnifiedScheduler(vi.fn());
    await vi.waitFor(() => expect(mocks.advance).toHaveBeenCalledWith(automation, 'failed', 'legacy failure'));
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', trigger: 'schedule' }));
    await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalledTimes(1));
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', metadata: expect.objectContaining({ runId: 'legacy-run-1' }) }));
  });
});
