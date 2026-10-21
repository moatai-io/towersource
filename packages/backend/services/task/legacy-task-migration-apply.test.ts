import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryOne = vi.fn();
const execute = vi.fn();
const createAutomation = vi.fn();
const getAutomation = vi.fn();
const updateAutomation = vi.fn();

vi.mock('../../db/pg-repo.js', () => ({ queryOne, execute }));
vi.mock('./automation-manager.js', () => ({ createAutomation, getAutomation, updateAutomation }));

const { applyLegacyTaskScheduleMigrationItem } = await import('./legacy-task-migration-apply.js');

const item: any = {
  legacyTaskId: 'legacy-1', action: 'create_automation',
  proposedAutomation: {
    userId: 7, projectId: 'project-a', name: 'Daily monitor', description: 'Monitor', prompt: 'Monitor',
    model: null, workflow: 'auto', jobType: 'ai_prompt', scopeType: 'project', definitionJson: { legacyTaskId: 'legacy-1' },
    mode: 'spawn', cwd: '/workspace/project-a', triggerType: 'cron', cronConfig: { type: 'daily', hour: 9, minute: 0 }, onceAt: null,
  },
};

describe('legacy task migration cutover', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates the Automation disabled, stops legacy execution, then enables the Automation', async () => {
    queryOne
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ schedule_enabled: 1 });
    createAutomation.mockResolvedValueOnce({ id: 'automation-1', enabled: false });
    execute.mockResolvedValueOnce({ changes: 1 });
    getAutomation.mockResolvedValueOnce({ id: 'automation-1', enabled: false });
    updateAutomation.mockResolvedValueOnce({ id: 'automation-1', enabled: true });

    await expect(applyLegacyTaskScheduleMigrationItem(item)).resolves.toEqual({
      legacyTaskId: 'legacy-1', automationId: 'automation-1', outcome: 'migrated',
    });
    expect(createAutomation).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1 AND schedule_enabled = 1'), ['legacy-1']);
    expect(updateAutomation).toHaveBeenCalledWith('automation-1', { enabled: true, updatedByUserId: 7 });
    expect(createAutomation.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]);
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(updateAutomation.mock.invocationCallOrder[0]);
  });

  it('recovers an interrupted cutover without creating a duplicate Automation', async () => {
    queryOne
      .mockResolvedValueOnce({ id: 'automation-1', enabled: false })
      .mockResolvedValueOnce({ schedule_enabled: 0 });
    getAutomation.mockResolvedValueOnce({ id: 'automation-1', enabled: false });
    updateAutomation.mockResolvedValueOnce({ id: 'automation-1', enabled: true });

    await expect(applyLegacyTaskScheduleMigrationItem(item)).resolves.toMatchObject({ outcome: 'recovered', automationId: 'automation-1' });
    expect(createAutomation).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(updateAutomation).toHaveBeenCalledTimes(1);
  });

  it('fails closed if legacy disable loses its active-state race', async () => {
    queryOne
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ schedule_enabled: 1 });
    createAutomation.mockResolvedValueOnce({ id: 'automation-1', enabled: false });
    execute.mockResolvedValueOnce({ changes: 0 });

    await expect(applyLegacyTaskScheduleMigrationItem(item)).rejects.toThrow('active-state race');
    expect(updateAutomation).not.toHaveBeenCalled();
  });
});
