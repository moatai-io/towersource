import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/pg-repo.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
}));

import { query } from '../../db/pg-repo.js';
import { planLegacyTaskScheduleMigration } from './legacy-task-migration.js';

describe('planLegacyTaskScheduleMigration', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('builds a read-only automation plan for cron and once legacy tasks', async () => {
    vi.mocked(query).mockResolvedValue([
      {
        id: 'task-cron',
        user_id: 1,
        project_id: 'proj1',
        title: 'Daily report',
        description: 'Write report',
        cwd: '/home/tower/workspace/projects/proj1',
        status: 'todo',
        scheduled_at: null,
        schedule_cron: JSON.stringify({ type: 'daily', hour: 3, minute: 0 }),
        schedule_enabled: 1,
        model: 'claude-haiku-4-20250414',
        workflow: 'simple',
        room_id: null,
        triggered_by: null,
        room_message_id: null,
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'task-once',
        user_id: 2,
        project_id: null,
        title: 'One shot',
        description: '',
        cwd: '/home/tower/workspace',
        status: 'todo',
        scheduled_at: '2026-06-03T01:00:00.000Z',
        schedule_cron: null,
        schedule_enabled: 1,
        model: 'claude-opus-4-8',
        workflow: 'auto',
        room_id: null,
        triggered_by: null,
        room_message_id: null,
        created_at: '2026-01-02T00:00:00Z',
      },
    ] as any);

    const plan = await planLegacyTaskScheduleMigration();

    expect(plan.candidateCount).toBe(2);
    expect(plan.createCount).toBe(2);
    expect(plan.items[0]).toMatchObject({
      legacyTaskId: 'task-cron',
      action: 'create_automation',
      proposedAutomation: {
        name: 'Daily report',
        jobType: 'ai_prompt',
        scopeType: 'project',
        triggerType: 'cron',
        projectId: 'proj1',
      },
    });
    expect(plan.items[1]).toMatchObject({
      legacyTaskId: 'task-once',
      action: 'create_automation',
      proposedAutomation: {
        name: 'One shot',
        scopeType: 'system',
        triggerType: 'once',
        onceAt: '2026-06-03T01:00:00.000Z',
      },
    });
  });

  it('skips rows missing user_id', async () => {
    vi.mocked(query).mockResolvedValue([
      {
        id: 'bad',
        user_id: null,
        project_id: null,
        title: 'Bad',
        description: '',
        cwd: '/home/tower/workspace',
        status: 'todo',
        scheduled_at: '2026-06-03T01:00:00.000Z',
        schedule_cron: null,
        schedule_enabled: 1,
        model: null,
        workflow: null,
        room_id: null,
        triggered_by: null,
        room_message_id: null,
        created_at: '2026-01-02T00:00:00Z',
      },
    ] as any);

    const plan = await planLegacyTaskScheduleMigration();
    expect(plan.skipCount).toBe(1);
    expect(plan.items[0]).toMatchObject({ action: 'skip', reason: 'missing user_id' });
  });
});
