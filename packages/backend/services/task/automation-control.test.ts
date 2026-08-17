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
  runAutomationJob: vi.fn(async () => ({ status: 'success', resultId: 'session-1', summaryText: 'done', runnerKind: 'ai' })),
}));
vi.mock('./schedule-permissions.js', () => ({ canAccessAutomationJob: vi.fn(async () => ({ allowed: true })) }));

import { appendProcessEvent } from '../process/process-map-manager.js';
import { logRun, recordAutomationRuntimeResult } from './automation-manager.js';
import { runAutomationJob } from './automation-runners.js';
import { runAutomationNow } from './automation-control.js';
import type { Automation } from './automation-manager.js';

const automation = {
  id: 'a1', userId: 7, projectId: 'p1', name: 'briefing', mode: 'spawn', sessionId: null,
} as Automation;

describe('runAutomationNow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the runner and records the same run ledger and process event contract', async () => {
    const broadcast = vi.fn();
    const result = await runAutomationNow({ automation, broadcast });

    expect(runAutomationJob).toHaveBeenCalledWith(automation, broadcast);
    expect(logRun).toHaveBeenCalledWith(expect.objectContaining({ automationId: 'a1', trigger: 'manual', status: 'success' }));
    expect(recordAutomationRuntimeResult).toHaveBeenCalledWith('a1', 'success', null);
    expect(appendProcessEvent).toHaveBeenCalledWith(expect.objectContaining({
      automationId: 'a1', runId: 'run-1', sourceType: 'automation_run', eventType: 'step_completed',
    }));
    expect(result).toMatchObject({ runId: 'run-1', status: 'success', resultId: 'session-1' });
  });
});
