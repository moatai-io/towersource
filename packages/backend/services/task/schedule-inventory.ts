/**
 * Owns: the complete user-facing inventory of jobs the unified scheduler may run.
 * Public API: listScheduleInventory(), getLegacyScheduledTask(), setLegacyScheduledTaskEnabled().
 *
 * The unified scheduler still executes legacy tasks.schedule_enabled rows during
 * migration. This projection keeps those rows visible beside automations without
 * pretending that they are native Automation records.
 */
import { execute, query, queryOne } from '../../db/pg-repo.js';
import { getAccessibleProjectIds } from '../pm/project-membership-manager.js';
import { getAutomations, type Automation } from './automation-manager.js';
import { isScheduleOperator } from './schedule-permissions.js';

export type ScheduleInventorySource = 'automation' | 'legacy_task';

export interface ScheduleInventoryItem {
  source: ScheduleInventorySource;
  id: string;
  name: string;
  description: string;
  projectId: string | null;
  projectName: string | null;
  ownerUserId: number | null;
  ownerName: string | null;
  enabled: boolean;
  status: string;
  triggerType: 'cron' | 'once' | 'manual';
  cronConfig: unknown | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  runCount: number;
  canControl: boolean;
  migrationRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

interface LegacyScheduledTaskRow {
  id: string;
  title: string;
  description: string | null;
  user_id: number | null;
  owner_name: string | null;
  project_id: string | null;
  project_name: string | null;
  status: string;
  schedule_enabled: number | boolean | null;
  scheduled_at: string | null;
  schedule_cron: string | null;
  created_at: string;
  updated_at: string;
}

function parseJson(value: string | null): unknown | null {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return value; }
}

function nativeItem(automation: Automation, projectName: string | null, actorUserId: number, actorRole?: string | null): ScheduleInventoryItem {
  return {
    source: 'automation',
    id: automation.id,
    name: automation.name,
    description: automation.description,
    projectId: automation.projectId,
    projectName,
    ownerUserId: automation.userId,
    ownerName: automation.creatorName,
    enabled: automation.enabled,
    status: automation.status,
    triggerType: automation.triggerType === 'event' ? 'manual' : automation.triggerType,
    cronConfig: automation.cronConfig,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
    lastStatus: automation.lastStatus,
    lastError: automation.lastError,
    runCount: automation.runCount,
    canControl: automation.userId === actorUserId || isScheduleOperator(actorRole),
    migrationRequired: false,
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
  };
}

function legacyItem(row: LegacyScheduledTaskRow, actorUserId: number, actorRole?: string | null): ScheduleInventoryItem {
  return {
    source: 'legacy_task',
    id: row.id,
    name: row.title,
    description: row.description || '',
    projectId: row.project_id,
    projectName: row.project_name,
    ownerUserId: row.user_id,
    ownerName: row.owner_name,
    enabled: row.schedule_enabled === 1 || row.schedule_enabled === true,
    status: row.status,
    triggerType: row.schedule_cron ? 'cron' : row.scheduled_at ? 'once' : 'manual',
    cronConfig: parseJson(row.schedule_cron),
    nextRunAt: row.scheduled_at,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    runCount: 0,
    canControl: row.user_id === actorUserId || isScheduleOperator(actorRole),
    migrationRequired: true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listScheduleInventory(params: {
  userId: number;
  role?: string | null;
  projectId?: string | null;
  includeArchived?: boolean;
}): Promise<ScheduleInventoryItem[]> {
  const automations = await getAutomations(params.userId, params.role || undefined, {
    projectId: params.projectId || undefined,
    includeArchived: params.includeArchived || false,
  });

  const projectIds = [...new Set(automations.map(item => item.projectId).filter((id): id is string => !!id))];
  const projectNames = new Map<string, string>();
  if (projectIds.length > 0) {
    const rows = await query<{ id: string; name: string }>('SELECT id, name FROM projects WHERE id = ANY($1::text[])', [projectIds]);
    for (const row of rows) projectNames.set(row.id, row.name);
  }

  const values: unknown[] = [];
  const conditions = ['t.schedule_enabled = 1', "t.status = 'todo'", '(t.archived IS NULL OR t.archived = 0)'];
  if (params.projectId) {
    values.push(params.projectId);
    conditions.push(`t.project_id = $${values.length}`);
  }
  const legacyRows = await query<LegacyScheduledTaskRow>(`
    SELECT t.id, t.title, t.description, t.user_id, u.username AS owner_name,
           t.project_id, p.name AS project_name, t.status, t.schedule_enabled,
           t.scheduled_at, t.schedule_cron, t.created_at, t.updated_at
      FROM tasks t
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN projects p ON p.id = t.project_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY t.updated_at DESC
  `, values);

  const accessibleIds = await getAccessibleProjectIds(params.userId, params.role || 'member');
  const visibleLegacy = accessibleIds === null
    ? legacyRows
    : legacyRows.filter(row => row.project_id ? accessibleIds.includes(row.project_id) : row.user_id === params.userId);

  return [
    ...automations.map(item => nativeItem(item, item.projectId ? projectNames.get(item.projectId) || null : null, params.userId, params.role)),
    ...visibleLegacy.map(row => legacyItem(row, params.userId, params.role)),
  ].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

export async function getLegacyScheduledTask(id: string): Promise<LegacyScheduledTaskRow | null> {
  return await queryOne<LegacyScheduledTaskRow>(`
    SELECT t.id, t.title, t.description, t.user_id, u.username AS owner_name,
           t.project_id, p.name AS project_name, t.status, t.schedule_enabled,
           t.scheduled_at, t.schedule_cron, t.created_at, t.updated_at
      FROM tasks t
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.id = $1
  `, [id]) || null;
}

export async function setLegacyScheduledTaskEnabled(params: {
  id: string;
  enabled: boolean;
  userId: number;
  role?: string | null;
}): Promise<boolean> {
  const row = await getLegacyScheduledTask(params.id);
  if (!row) return false;
  if (row.user_id !== params.userId && !isScheduleOperator(params.role)) {
    throw Object.assign(new Error('legacy schedule control requires the task owner or an operator'), { code: 'FORBIDDEN' });
  }
  const result = await execute('UPDATE tasks SET schedule_enabled = $1, updated_at = NOW() WHERE id = $2', [params.enabled ? 1 : 0, params.id]);
  return result.changes > 0;
}
