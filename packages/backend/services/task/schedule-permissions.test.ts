import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../pm/project-membership-manager.js', () => ({
  isProjectMember: vi.fn(async (projectId: string, userId: number) => projectId === 'p1' && userId === 7),
}));

vi.mock('../runtime-box/policy.js', () => ({
  isRuntimeBoxEnabled: vi.fn(() => true),
}));

import { canAccessAutomationJob, canCreateAutomationJob } from './schedule-permissions.js';
import { isRuntimeBoxEnabled } from '../runtime-box/policy.js';

describe('schedule-permissions', () => {
  beforeEach(() => {
    vi.mocked(isRuntimeBoxEnabled).mockReturnValue(true);
  });

  it('allows admin/operator to create host shell jobs', async () => {
    await expect(canCreateAutomationJob({
      userId: 1,
      role: 'admin',
      jobType: 'shell',
      scopeType: 'system',
      definitionJson: { command: 'echo ok' },
    })).resolves.toMatchObject({ allowed: true });
  });

  it('blocks member host shell/script jobs', async () => {
    await expect(canCreateAutomationJob({
      userId: 7,
      role: 'member',
      jobType: 'shell',
      scopeType: 'system',
      definitionJson: { command: 'echo ok' },
    })).resolves.toMatchObject({ allowed: false, status: 403 });
  });

  it('allows member project shell jobs only with explicit fail-closed Runtime Box runner', async () => {
    await expect(canCreateAutomationJob({
      userId: 7,
      role: 'member',
      projectId: 'p1',
      jobType: 'shell',
      scopeType: 'project',
      definitionJson: {
        command: 'python scripts/report.py',
        runner: { preference: 'runtime_box', fallback: 'fail' },
      },
    })).resolves.toMatchObject({ allowed: true });
  });

  it('blocks member project shell jobs when Runtime Box fallback is host', async () => {
    await expect(canCreateAutomationJob({
      userId: 7,
      role: 'member',
      projectId: 'p1',
      jobType: 'shell',
      scopeType: 'project',
      definitionJson: {
        command: 'python scripts/report.py',
        runner: { preference: 'runtime_box', fallback: 'admin_host' },
      },
    })).resolves.toMatchObject({ allowed: false, status: 403 });
  });

  it('allows project members to read and propose changes to project automations', async () => {
    await expect(canAccessAutomationJob({ userId: 99, projectId: 'p1' }, 7, 'member', 'read'))
      .resolves.toMatchObject({ allowed: true });
    await expect(canAccessAutomationJob({ userId: 99, projectId: 'p1' }, 7, 'member', 'propose'))
      .resolves.toMatchObject({ allowed: true });
  });

  it.each(['run', 'edit', 'archive'] as const)('blocks project members from %s on another owner automation', async (capability) => {
    await expect(canAccessAutomationJob({ userId: 99, projectId: 'p1' }, 7, 'member', capability))
      .resolves.toMatchObject({ allowed: false, status: 403 });
  });

  it.each(['read', 'propose', 'run', 'edit', 'archive'] as const)('allows the automation owner to %s', async (capability) => {
    await expect(canAccessAutomationJob({ userId: 7, projectId: 'p1' }, 7, 'member', capability))
      .resolves.toMatchObject({ allowed: true });
  });

  it.each(['read', 'propose', 'run', 'edit', 'archive'] as const)('allows an operator to %s', async (capability) => {
    await expect(canAccessAutomationJob({ userId: 99, projectId: 'p2' }, 1, 'operator', capability))
      .resolves.toMatchObject({ allowed: true });
  });

  it('blocks non-members from project automations', async () => {
    await expect(canAccessAutomationJob({ userId: 99, projectId: 'p2' }, 7, 'member', 'read'))
      .resolves.toMatchObject({ allowed: false, status: 403 });
  });
});
