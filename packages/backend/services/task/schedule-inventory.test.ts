import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
const queryOne = vi.fn();
const execute = vi.fn();
const getAutomations = vi.fn();
const getAccessibleProjectIds = vi.fn();

vi.mock('../../db/pg-repo.js', () => ({ query, queryOne, execute }));
vi.mock('./automation-manager.js', () => ({ getAutomations }));
vi.mock('../pm/project-membership-manager.js', () => ({ getAccessibleProjectIds }));

const { listScheduleInventory, setLegacyScheduledTaskEnabled } = await import('./schedule-inventory.js');

describe('complete schedule inventory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAutomations.mockResolvedValue([]);
    getAccessibleProjectIds.mockResolvedValue(['project-a']);
  });

  it('surfaces active legacy tasks that the unified scheduler can run in the current project', async () => {
    query.mockResolvedValueOnce([{
      id: 'legacy-1', title: 'Daily monitor', description: 'Check activity', user_id: 7, owner_name: 'owner',
      project_id: 'project-a', project_name: 'Agent A', status: 'todo', schedule_enabled: 1,
      scheduled_at: '2026-09-02T00:00:00Z', schedule_cron: JSON.stringify({ type: 'daily', hour: 9, minute: 0 }),
      created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T01:00:00Z',
    }]);

    const items = await listScheduleInventory({ userId: 7, role: 'member', projectId: 'project-a' });

    expect(items).toEqual([expect.objectContaining({
      source: 'legacy_task', id: 'legacy-1', projectId: 'project-a', enabled: true,
      triggerType: 'cron', canControl: true, migrationRequired: true,
    })]);
    expect(query.mock.calls[0][0]).toContain('t.schedule_enabled = 1');
    expect(query.mock.calls[0][0]).toContain("t.status = 'todo'");
    expect(query.mock.calls[0][0]).toContain('t.project_id = $1');
  });

  it('does not expose legacy tasks from inaccessible projects', async () => {
    query.mockResolvedValueOnce([{
      id: 'legacy-2', title: 'Other project', description: '', user_id: 8, owner_name: 'other',
      project_id: 'project-b', project_name: 'Agent B', status: 'todo', schedule_enabled: 1,
      scheduled_at: null, schedule_cron: '{}', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    }]);

    await expect(listScheduleInventory({ userId: 7, role: 'member' })).resolves.toEqual([]);
  });

  it('allows only the owner or an operator to disable a legacy schedule', async () => {
    queryOne.mockResolvedValueOnce({ id: 'legacy-1', user_id: 7 });
    execute.mockResolvedValueOnce({ changes: 1 });
    await expect(setLegacyScheduledTaskEnabled({ id: 'legacy-1', enabled: false, userId: 7, role: 'member' })).resolves.toBe(true);
    expect(execute).toHaveBeenCalledWith('UPDATE tasks SET schedule_enabled = $1, updated_at = NOW() WHERE id = $2', [0, 'legacy-1']);

    queryOne.mockResolvedValueOnce({ id: 'legacy-2', user_id: 8 });
    await expect(setLegacyScheduledTaskEnabled({ id: 'legacy-2', enabled: false, userId: 7, role: 'member' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
