import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeWorkbenchRequest } from '../runtime-box/workbench-execution-broker.js';
import { createLocalWorkbenchExecutionProvider } from '../runtime-box/workbench-local-execution-provider.js';
import { runAutomationJob } from './automation-runners.js';
import { canCreateAutomationJob } from './schedule-permissions.js';
import type { Automation } from './automation-manager.js';

vi.mock('../runtime-box/workbench-execution-broker.js', () => ({ executeWorkbenchRequest: vi.fn() }));
vi.mock('../runtime-box/workbench-local-execution-provider.js', () => ({ createLocalWorkbenchExecutionProvider: vi.fn(() => ({ kind: 'local-runtime' })) }));
vi.mock('../runtime-box/policy.js', () => ({ isRuntimeBoxEnabled: vi.fn(() => true) }));
vi.mock('../pm/project-membership-manager.js', () => ({ isProjectMember: vi.fn(async () => true) }));

function automation(definitionJson: Record<string, unknown>): Automation {
  return {
    id: 'a1', userId: 7, projectId: 'p1', name: 'Workbench schedule', description: '', prompt: '', model: '', workflow: 'auto',
    jobType: 'workbench_execution', scopeType: 'project', definitionJson, riskLevel: 'low', timeoutSeconds: 120,
    timezone: 'Asia/Seoul', createdBySessionId: 's1', updatedByUserId: null, configUpdatedAt: '', configUpdatedByUserId: null,
    runtimeStateJson: {}, mode: 'spawn', targetId: null, cwd: '/workspace', triggerType: 'cron', cronConfig: { type: 'daily', hour: 9, minute: 0 },
    onceAt: null, status: 'idle', enabled: true, sortOrder: 0, sessionId: null, nextRunAt: null, lastRunAt: null,
    runCount: 0, lastStatus: null, lastError: null, progressSummary: [], todoSnapshot: null, parentId: null, worktreePath: null,
    roomId: null, triggeredBy: null, roomMessageId: null, creatorName: null, createdAt: '', updatedAt: '', completedAt: null,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('Workbench execution automation vertical slice', () => {
  it('routes a scheduled Job through the unified execution broker and returns durable Job ref', async () => {
    vi.mocked(executeWorkbenchRequest).mockResolvedValue({
      plan: { lifecycle: 'job', providerKind: 'local-runtime', reason: 'test', risk: 'normal', limitations: [] },
      execution: { lifecycle: 'job', providerKind: 'local-runtime', durable: true, job: { id: 44, status: 'queued' } as any },
    });
    const result = await runAutomationJob(automation({ command: 'npm test', lifecycle: 'job' }));
    expect(executeWorkbenchRequest).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ command: 'npm test', lifecycle: 'job', timeoutSec: 120 }),
      context: { projectId: 'p1', userId: 7, sessionId: 's1' },
      provider: { kind: 'local-runtime' },
    }));
    expect(result).toMatchObject({ status: 'success', resultId: '44', runnerKind: 'runtime_box', runnerRef: 'workbench-job:44' });
  });

  it('records a managed Service identity from the same automation job type', async () => {
    vi.mocked(executeWorkbenchRequest).mockResolvedValue({
      plan: { lifecycle: 'service', providerKind: 'local-runtime', reason: 'test', risk: 'normal', serviceName: 'api', limitations: [] },
      execution: { lifecycle: 'service', providerKind: 'local-runtime', service: { id: 9, name: 'api' } as any },
    });
    await expect(runAutomationJob(automation({ command: 'uvicorn app:api', lifecycle: 'service', service: { name: 'api' } })))
      .resolves.toMatchObject({ resultId: '9', runnerRef: 'workbench-service:9' });
  });

  it('requires Project scope and Runtime Box availability at creation policy', async () => {
    await expect(canCreateAutomationJob({ userId: 7, role: 'member', projectId: 'p1', jobType: 'workbench_execution', scopeType: 'project' }))
      .resolves.toEqual({ allowed: true });
    await expect(canCreateAutomationJob({ userId: 7, role: 'member', jobType: 'workbench_execution', scopeType: 'system' }))
      .resolves.toMatchObject({ allowed: false, status: 403 });
  });

  it('rejects missing command before any provider execution', async () => {
    await expect(runAutomationJob(automation({ lifecycle: 'job' }))).rejects.toThrow('definition_json.command');
    expect(createLocalWorkbenchExecutionProvider).not.toHaveBeenCalled();
  });
});
