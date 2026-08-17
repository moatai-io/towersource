import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./schedule-permissions.js', () => ({
  canCreateAutomationJob: vi.fn(async () => ({ allowed: true })),
}));

import { authorizeAutomationMutation } from './automation-mutation-policy.js';
import { canCreateAutomationJob } from './schedule-permissions.js';
import type { Automation } from './automation-manager.js';

function existingAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a1', userId: 7, projectId: 'p1', name: 'briefing', description: '', prompt: 'summarize', model: 'model', workflow: 'auto',
    jobType: 'ai_prompt', scopeType: 'project', definitionJson: { prompt: 'summarize' }, riskLevel: 'low', timeoutSeconds: null,
    timezone: 'Asia/Seoul', createdBySessionId: null, updatedByUserId: null, configUpdatedAt: '', configUpdatedByUserId: null,
    runtimeStateJson: {}, mode: 'spawn', targetId: null, cwd: '/workspace', triggerType: 'manual', cronConfig: null, onceAt: null,
    status: 'idle', enabled: true, sortOrder: 0, sessionId: null, nextRunAt: null, lastRunAt: null, runCount: 0,
    lastStatus: null, lastError: null, progressSummary: [], todoSnapshot: null, parentId: null, worktreePath: null, roomId: null,
    triggeredBy: null, roomMessageId: null, creatorName: null, createdAt: '', updatedAt: '', completedAt: null,
    ...overrides,
  };
}

describe('authorizeAutomationMutation', () => {
  beforeEach(() => {
    vi.mocked(canCreateAutomationJob).mockResolvedValue({ allowed: true });
  });

  it('revalidates an update using the effective project, scope, job type, and definition', async () => {
    const result = await authorizeAutomationMutation({
      actor: { userId: 7, role: 'member' },
      existing: existingAutomation(),
      mutation: {
        jobType: 'shell',
        definitionJson: {
          command: 'python scripts/report.py',
          runner: { preference: 'runtime_box', fallback: 'fail' },
        },
      },
    });

    expect(result).toMatchObject({ allowed: true, jobType: 'shell', scopeType: 'project', riskLevel: 'medium' });
    expect(canCreateAutomationJob).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      role: 'member',
      projectId: 'p1',
      jobType: 'shell',
      scopeType: 'project',
    }));
  });

  it('does not trust a client risk downgrade and requires confirmation for an effective high-risk command', async () => {
    await expect(authorizeAutomationMutation({
      actor: { userId: 1, role: 'admin' },
      existing: existingAutomation(),
      mutation: {
        jobType: 'shell',
        definitionJson: { command: 'git push origin main' },
      },
    })).resolves.toMatchObject({ allowed: false, status: 400, riskLevel: 'high' });
  });

  it('allows the same high-risk definition only with an explicit confirmation', async () => {
    await expect(authorizeAutomationMutation({
      actor: { userId: 1, role: 'admin' },
      existing: existingAutomation(),
      mutation: {
        jobType: 'shell',
        definitionJson: { command: 'git push origin main' },
        confirmedHighRisk: true,
      },
    })).resolves.toMatchObject({ allowed: true, riskLevel: 'high' });
  });

  it('propagates creation-policy denial for an alternate mutation path', async () => {
    vi.mocked(canCreateAutomationJob).mockResolvedValue({ allowed: false, status: 403, message: 'forbidden' });
    await expect(authorizeAutomationMutation({
      actor: { userId: 7, role: 'member' },
      existing: existingAutomation(),
      mutation: { projectId: 'p2' },
    })).resolves.toEqual({ allowed: false, status: 403, message: 'forbidden' });
  });
});
