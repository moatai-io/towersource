/**
 * Owns: dry-run planning for moving legacy tasks.scheduled_at jobs to automations.
 * Public API: planLegacyTaskScheduleMigration(). See services/task/README.md.
 */
import { query } from '../../db/pg-repo.js';
import { calculateNextRun, type CronConfig } from './automation-manager.js';

export interface LegacyTaskScheduleRow {
  id: string;
  user_id: number | null;
  project_id: string | null;
  title: string;
  description: string | null;
  cwd: string;
  status: string;
  scheduled_at: string | null;
  schedule_cron: string | null;
  schedule_enabled: number | boolean | null;
  model: string | null;
  workflow: string | null;
  room_id: string | null;
  triggered_by: number | null;
  room_message_id: string | null;
  created_at: string;
}

export interface LegacyTaskMigrationPlanItem {
  legacyTaskId: string;
  action: 'create_automation' | 'skip';
  reason?: string;
  proposedAutomation?: {
    name: string;
    description: string;
    prompt: string;
    model: string | null;
    workflow: string | null;
    jobType: 'ai_prompt';
    scopeType: 'project' | 'system';
    mode: 'spawn';
    triggerType: 'cron' | 'once';
    cronConfig: CronConfig | null;
    onceAt: string | null;
    nextRunAt: string | null;
    projectId: string | null;
    cwd: string;
    userId: number | null;
    definitionJson: Record<string, unknown>;
  };
}

export interface LegacyTaskMigrationPlan {
  generatedAt: string;
  source: 'tasks';
  candidateCount: number;
  createCount: number;
  skipCount: number;
  items: LegacyTaskMigrationPlanItem[];
}

/**
 * Builds a read-only migration plan. Does not create automations or disable tasks.
 */
export async function planLegacyTaskScheduleMigration(): Promise<LegacyTaskMigrationPlan> {
  const rows = await query<LegacyTaskScheduleRow>(`
    SELECT id, user_id, project_id, title, description, cwd, status,
           scheduled_at, schedule_cron, schedule_enabled,
           model, workflow, room_id, triggered_by, room_message_id, created_at
    FROM tasks
    WHERE schedule_enabled = 1
      AND (archived IS NULL OR archived = 0)
    ORDER BY created_at DESC
  `);

  const items = rows.map(planRow);
  return {
    generatedAt: new Date().toISOString(),
    source: 'tasks',
    candidateCount: rows.length,
    createCount: items.filter(i => i.action === 'create_automation').length,
    skipCount: items.filter(i => i.action === 'skip').length,
    items,
  };
}

function planRow(row: LegacyTaskScheduleRow): LegacyTaskMigrationPlanItem {
  const cronConfig = parseCron(row.schedule_cron);
  const hasCron = !!cronConfig;
  const hasOnce = !!row.scheduled_at;

  if (row.status !== 'todo') {
    return { legacyTaskId: row.id, action: 'skip', reason: `status is ${row.status}, not todo` };
  }

  if (!hasCron && !hasOnce) {
    return { legacyTaskId: row.id, action: 'skip', reason: 'no cron config or scheduled_at' };
  }

  if (!row.user_id) {
    return { legacyTaskId: row.id, action: 'skip', reason: 'missing user_id' };
  }

  const triggerType = hasCron ? 'cron' : 'once';
  const onceAt = triggerType === 'once' ? normalizeDate(row.scheduled_at) : null;
  if (triggerType === 'once' && !onceAt) {
    return { legacyTaskId: row.id, action: 'skip', reason: 'invalid scheduled_at' };
  }

  let nextRunAt: string | null = null;
  if (triggerType === 'cron' && cronConfig) {
    nextRunAt = calculateNextRun(cronConfig).toISOString();
  } else if (onceAt) {
    nextRunAt = onceAt;
  }

  return {
    legacyTaskId: row.id,
    action: 'create_automation',
    proposedAutomation: {
      name: row.title,
      description: row.description || '',
      prompt: row.description || row.title,
      model: row.model,
      workflow: row.workflow,
      jobType: 'ai_prompt',
      scopeType: row.project_id ? 'project' : 'system',
      mode: 'spawn',
      triggerType,
      cronConfig: triggerType === 'cron' ? cronConfig : null,
      onceAt,
      nextRunAt,
      projectId: row.project_id,
      cwd: row.cwd,
      userId: row.user_id,
      definitionJson: {
        source: 'legacy_task_schedule',
        legacyTaskId: row.id,
        legacyTaskStatus: row.status,
        legacyScheduleEnabled: row.schedule_enabled,
        legacyScheduledAt: row.scheduled_at,
        legacyScheduleCron: row.schedule_cron,
        roomId: row.room_id,
        triggeredBy: row.triggered_by,
        roomMessageId: row.room_message_id,
      },
    },
  };
}

function parseCron(raw: string | null): CronConfig | null {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!['daily', 'weekdays', 'weekly', 'interval'].includes(parsed.type)) return null;
    return parsed as CronConfig;
  } catch {
    return null;
  }
}

function normalizeDate(raw: string | null): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
