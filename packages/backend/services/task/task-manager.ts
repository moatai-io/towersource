import { query, queryOne, execute, transaction, withClient } from '../../db/pg-repo.js';
import { v4 as uuidv4 } from 'uuid';
import { getAccessibleProjectIds } from '../pm/project-membership-manager.js';
import { findProjectByPath } from '../pm/project-access.js';
import { getModelDefaults, resolveLegacyPiModelId } from '../../config.js';
export type { WorkflowMode, TaskMeta, TaskReportPolicy } from '@tower/shared';
import type { TaskMeta, WorkflowMode, TaskReportPolicy } from '@tower/shared';

export interface ScheduleCron {
  type: 'daily' | 'weekdays' | 'weekly' | 'interval';
  hour?: number;
  minute?: number;
  day?: number;   // 0=Sun, 1=Mon, ..., 6=Sat (for 'weekly')
  hours?: number; // for 'interval' type (legacy hours-only form)
  /**
   * Minutes-based interval (1..10080 = 1주). Takes precedence over `hours`
   * when both are set. Added 2026-05-16 to support sub-hour cron — backend
   * tick is 30s so 1-minute cadence is feasible. Validate via
   * task-scheduler.ts `validateCron()`.
   */
  minutes?: number;
}

function inferEngineFromModel(modelId: string): 'claude' | 'pi' | 'local' {
  if (modelId.includes('/')) return 'pi';
  if (modelId.startsWith('local:')) return 'local';
  return 'claude';
}

function mapRow(row: any): TaskMeta {
  let todoSnapshot = null;
  if (row.todo_snapshot) {
    try { todoSnapshot = JSON.parse(row.todo_snapshot); } catch {}
  }
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    cwd: row.cwd,
    // Engine column added 2026-05-17. If legacy rows have no engine/model,
    // derive both from the admin-configured Core mapping.
    engine: (row.engine || inferEngineFromModel(row.model || getModelDefaults().session)) as 'claude' | 'pi' | 'local',
    model: row.model || getModelDefaults().session,
    status: row.status,
    sessionId: row.session_id,
    sortOrder: row.sort_order,
    progressSummary: JSON.parse(row.progress_summary || '[]'),
    todoSnapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    userId: row.user_id,
    creatorName: row.creator_name || null,
    scheduledAt: row.scheduled_at || null,
    scheduleCron: row.schedule_cron || null,
    scheduleEnabled: row.schedule_enabled === 1 || row.schedule_enabled === true,
    workflow: (row.workflow as WorkflowMode) || 'auto',
    parentTaskId: row.parent_task_id || null,
    worktreePath: row.worktree_path || null,
    projectId: row.project_id || null,
    roomId: row.room_id || null,
    triggeredBy: row.triggered_by || null,
    roomMessageId: row.room_message_id || null,
    reportPolicy: (row.report_policy as TaskReportPolicy) || 'silent',
  };
}

/**
 * @deprecated Use findProjectByPath from project-access.js instead
 * This function is kept for backward compatibility but delegates to the canonical implementation
 */
export async function resolveProjectFromCwd(cwd: string): Promise<string | null> {
  return findProjectByPath(cwd);
}

export const SYSTEM_PROJECT_SENTINEL_ID = '00000000-0000-0000-0000-000000000000';

export function normalizeTaskProjectId(projectId: string | null | undefined): string | null | undefined {
  return projectId === SYSTEM_PROJECT_SENTINEL_ID ? null : projectId;
}

export async function createTask(
  title: string,
  description: string,
  cwd: string,
  userId?: number,
  model?: string,
  _legacySchedule?: { scheduledAt?: string | null; scheduleCron?: string | null; scheduleEnabled?: boolean },
  workflow?: WorkflowMode,
  parentTaskId?: string,
  projectId?: string | null,
  roomInfo?: { roomId: string; triggeredBy?: number | null; roomMessageId?: string | null },
  reportPolicy?: TaskReportPolicy,
  /**
   * Engine that runs this task (column added 2026-05-17, migration 058).
   * Default follows Admin → AI Settings → Core mapping.
   * 'pi' routes through PiEngine. Caller should match model accordingly
   * (e.g. engine='pi' with the configured Core Router ID).
   */
  engine?: 'claude' | 'pi' | 'local',
): Promise<TaskMeta> {
  const id = uuidv4();
  const maxOrder = await queryOne<any>('SELECT MAX(sort_order) as max_order FROM tasks WHERE status = $1', ['todo']);
  const sortOrder = (maxOrder?.max_order ?? -1) + 1;
  // Task creation defaults now follow Admin → AI Settings → Core (session default).
  // If a caller provides only a model, infer the engine from the model id so
  // provider/model Pi defaults do not accidentally
  // run through Claude.
  const requestedModel = model || getModelDefaults().session;
  const resolvedModel = resolveLegacyPiModelId(requestedModel);
  const resolvedEngine = engine || inferEngineFromModel(resolvedModel);

  // Auto-resolve only when the caller omitted projectId. Explicit null means
  // system/personal scope and must not be rebound from cwd.
  const normalizedProjectId = normalizeTaskProjectId(projectId);
  const resolvedProjectId = normalizedProjectId === undefined
    ? await resolveProjectFromCwd(cwd)
    : normalizedProjectId;

  // New tasks may write only current policies. Legacy channel/kakao/all/default
  // values remain readable for existing rows but cannot create new dependencies.
  const resolvedPolicy = reportPolicy === 'notification' ? 'notification' : 'silent';

  await execute(`
    INSERT INTO tasks (id, title, description, cwd, engine, model, status, sort_order, user_id, scheduled_at, schedule_cron, schedule_enabled, workflow, parent_task_id, project_id, room_id, triggered_by, room_message_id, report_policy)
    VALUES ($1, $2, $3, $4, $5, $6, 'todo', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
  `, [
    id, title, description, cwd, resolvedEngine, resolvedModel, sortOrder, userId ?? null,
    null,
    null,
    0,
    workflow || 'auto',
    parentTaskId ?? null,
    resolvedProjectId,
    roomInfo?.roomId ?? null,
    roomInfo?.triggeredBy ?? null,
    roomInfo?.roomMessageId ?? null,
    resolvedPolicy,
  ]);

  return (await getTask(id))!;
}

export async function getTasks(userId?: number, role?: string): Promise<TaskMeta[]> {
  const rows = await query<any>(`
    SELECT t.*, u.username AS creator_name
    FROM tasks t
    LEFT JOIN users u ON u.id = t.user_id
    WHERE (t.archived IS NULL OR t.archived = 0)
    ORDER BY t.status, t.sort_order
  `);

  if (userId && role) {
    const accessibleIds = await getAccessibleProjectIds(userId, role);
    if (accessibleIds !== null) {
      // Member: project tasks by group membership, non-project tasks by creator
      return rows.filter((r: any) => {
        if (!r.project_id) return r.user_id === userId;
        return accessibleIds.includes(r.project_id);
      }).map(mapRow);
    }
    // admin / operator → all tasks visible
    return rows.map(mapRow);
  }

  // No auth context: filter by user_id only
  if (userId) {
    return rows.filter((r: any) => r.user_id === userId || r.user_id === null).map(mapRow);
  }
  return rows.map(mapRow);
}

export async function getTask(id: string): Promise<TaskMeta | null> {
  const row = await queryOne<any>('SELECT * FROM tasks WHERE id = $1', [id]);
  return row ? mapRow(row) : null;
}

export async function updateTask(id: string, updates: Partial<Pick<TaskMeta, 'title' | 'description' | 'cwd' | 'engine' | 'model' | 'status' | 'sessionId' | 'sortOrder' | 'progressSummary' | 'todoSnapshot' | 'completedAt' | 'workflow' | 'parentTaskId' | 'worktreePath' | 'projectId' | 'roomId' | 'triggeredBy' | 'roomMessageId' | 'reportPolicy'>>): Promise<TaskMeta | null> {
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (updates.title !== undefined) { fields.push(`title = $${paramIndex++}`); values.push(updates.title); }
  if (updates.description !== undefined) { fields.push(`description = $${paramIndex++}`); values.push(updates.description); }
  if (updates.cwd !== undefined) { fields.push(`cwd = $${paramIndex++}`); values.push(updates.cwd); }
  if (updates.engine !== undefined) { fields.push(`engine = $${paramIndex++}`); values.push(updates.engine); }
  if (updates.model !== undefined) { fields.push(`model = $${paramIndex++}`); values.push(updates.model); }
  if (updates.status !== undefined) { fields.push(`status = $${paramIndex++}`); values.push(updates.status); }
  if (updates.sessionId !== undefined) { fields.push(`session_id = $${paramIndex++}`); values.push(updates.sessionId); }
  if (updates.sortOrder !== undefined) { fields.push(`sort_order = $${paramIndex++}`); values.push(updates.sortOrder); }
  if (updates.progressSummary !== undefined) { fields.push(`progress_summary = $${paramIndex++}`); values.push(JSON.stringify(updates.progressSummary)); }
  if (updates.todoSnapshot !== undefined) { fields.push(`todo_snapshot = $${paramIndex++}`); values.push(updates.todoSnapshot ? JSON.stringify(updates.todoSnapshot) : null); }
  if (updates.completedAt !== undefined) { fields.push(`completed_at = $${paramIndex++}`); values.push(updates.completedAt); }
  if (updates.workflow !== undefined) { fields.push(`workflow = $${paramIndex++}`); values.push(updates.workflow); }
  if (updates.parentTaskId !== undefined) { fields.push(`parent_task_id = $${paramIndex++}`); values.push(updates.parentTaskId); }
  if (updates.worktreePath !== undefined) { fields.push(`worktree_path = $${paramIndex++}`); values.push(updates.worktreePath); }
  if (updates.projectId !== undefined) { fields.push(`project_id = $${paramIndex++}`); values.push(updates.projectId); }
  if (updates.roomId !== undefined) { fields.push(`room_id = $${paramIndex++}`); values.push(updates.roomId); }
  if (updates.triggeredBy !== undefined) { fields.push(`triggered_by = $${paramIndex++}`); values.push(updates.triggeredBy); }
  if (updates.roomMessageId !== undefined) { fields.push(`room_message_id = $${paramIndex++}`); values.push(updates.roomMessageId); }
  if (updates.reportPolicy !== undefined) {
    fields.push(`report_policy = $${paramIndex++}`);
    values.push(updates.reportPolicy === 'notification' ? 'notification' : 'silent');
  }

  if (fields.length === 0) return getTask(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);

  await execute(`UPDATE tasks SET ${fields.join(', ')} WHERE id = $${paramIndex}`, values);
  return getTask(id);
}

export async function getChildTasks(parentTaskId: string): Promise<TaskMeta[]> {
  const rows = await query<any>('SELECT * FROM tasks WHERE parent_task_id = $1 AND (archived IS NULL OR archived = 0) ORDER BY sort_order', [parentTaskId]);
  return rows.map(mapRow);
}

export async function deleteTask(id: string): Promise<boolean> {
  // Soft-delete: archive instead of permanent removal
  const result = await execute('UPDATE tasks SET archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
  return result.changes > 0;
}

export async function getArchivedTasks(userId?: number): Promise<TaskMeta[]> {
  const rows = userId
    ? await query<any>('SELECT * FROM tasks WHERE user_id = $1 AND archived = 1 ORDER BY updated_at DESC', [userId])
    : await query<any>('SELECT * FROM tasks WHERE archived = 1 ORDER BY updated_at DESC');
  return rows.map(mapRow);
}

export async function restoreTask(id: string): Promise<boolean> {
  const result = await execute('UPDATE tasks SET archived = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
  return result.changes > 0;
}

export async function permanentlyDeleteTask(id: string): Promise<boolean> {
  const result = await execute('DELETE FROM tasks WHERE id = $1', [id]);
  return result.changes > 0;
}

export async function getDistinctCwds(userId?: number): Promise<string[]> {
  const rows = userId
    ? await query<any>('SELECT DISTINCT cwd FROM tasks WHERE user_id = $1 ORDER BY cwd', [userId])
    : await query<any>('SELECT DISTINCT cwd FROM tasks ORDER BY cwd');
  return rows.map((r) => r.cwd);
}

/**
 * Backfill project_id for existing tasks that have NULL project_id.
 * Matches task cwd against project root_path using longest-prefix-match.
 * Safe to run multiple times (idempotent).
 */
export async function backfillTaskProjects(): Promise<{ updated: number; total: number }> {
  const orphans = await query<{ id: string; cwd: string }>(
    'SELECT id, cwd FROM tasks WHERE project_id IS NULL AND (archived IS NULL OR archived = 0)'
  );
  let updated = 0;
  for (const task of orphans) {
    const projectId = await resolveProjectFromCwd(task.cwd);
    if (projectId) {
      await execute('UPDATE tasks SET project_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [projectId, task.id]);
      updated++;
    }
  }
  return { updated, total: orphans.length };
}

export async function reorderTasks(taskIds: string[], status: string): Promise<void> {
  await transaction(async (client) => {
    const db = withClient(client);
    for (let index = 0; index < taskIds.length; index++) {
      await db.execute('UPDATE tasks SET sort_order = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3', [index, status, taskIds[index]]);
    }
  });
}
