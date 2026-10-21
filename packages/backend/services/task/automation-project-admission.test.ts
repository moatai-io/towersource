import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryOne: vi.fn(),
  getProject: vi.fn(),
}));

vi.mock('../../db/pg-repo.js', () => ({
  query: vi.fn(),
  queryOne: mocks.queryOne,
  execute: vi.fn(),
  transaction: vi.fn(),
  withClient: vi.fn(),
}));
vi.mock('../pm/project-membership-manager.js', () => ({ getAccessibleProjectIds: vi.fn() }));
vi.mock('../pm/project-manager.js', () => ({ getProject: mocks.getProject }));
vi.mock('../../config.js', () => ({ getModelDefaults: () => ({ session: 'test-model' }) }));
vi.mock('./job-risk.js', () => ({ classifyJobRisk: () => 'low' }));

import { createAutomation } from './automation-manager.js';

const input = {
  userId: 7,
  projectId: 'project-1',
  name: 'Daily brief',
  description: 'Prepare a brief',
  prompt: 'Summarize updates',
};

describe('automation project admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryOne.mockResolvedValue({ max_order: 0 });
  });

  it('rejects a project deleted before persistence', async () => {
    mocks.getProject.mockResolvedValue(null);
    await expect(createAutomation(input)).rejects.toThrow('selected Agent no longer exists');
  });

  it.each([
    { archived: true, lifecycleStatus: 'active' },
    { archived: false, lifecycleStatus: 'retired' },
  ])('rejects an inactive project before persistence: %j', async project => {
    mocks.getProject.mockResolvedValue({ id: 'project-1', rootPath: '/workspace/project-1', ...project });
    await expect(createAutomation(input)).rejects.toThrow('selected Agent is retired');
  });
});
