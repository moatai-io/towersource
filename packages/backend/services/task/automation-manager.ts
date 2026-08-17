/**
 * Automation Manager — Tasks + Schedules 통합 서비스
 *
 * 모든 AI 실행을 하나의 "automation" 엔티티로 관리:
 *   - trigger: manual (수동), cron (반복), once (일회), event (미래)
 *   - mode:    spawn (새 세션), inject (세션 주입), channel (legacy read-only compatibility)
 *   - status:  idle → running → done/failed, archived
 *
 * 기존 task-manager.ts + unified-scheduler.ts를 대체한다.
 */

import { query, queryOne, execute, transaction, withClient } from '../../db/pg-repo.js';
import type { PoolClient } from 'pg';
import { getAccessibleProjectIds } from '../pm/project-membership-manager.js';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { getModelDefaults } from '../../config.js';
import { classifyJobRisk, type JobRiskLevel } from './job-risk.js';
import { getProject } from '../pm/project-manager.js';

// ── Types ──

export type AutomationMode = 'spawn' | 'inject' | 'channel';
export type AutomationTrigger = 'manual' | 'cron' | 'once' | 'event';

export class InternalChannelRetiredError extends Error {
  readonly code = 'INTERNAL_CHANNEL_RETIRED';

  constructor() {
    super('Internal channels are retired. Use a session result with Notification reporting.');
    this.name = 'InternalChannelRetiredError';
  }
}

function assertNoNewInternalChannelDependency(input: { mode?: AutomationMode; roomId?: string | null }): void {
  if (input.mode === 'channel' || input.roomId) throw new InternalChannelRetiredError();
}
export type AutomationStatus = 'idle' | 'running' | 'done' | 'failed' | 'archived';
export type AutomationJobType = 'ai_prompt' | 'webhook' | 'shell' | 'script' | 'monitor' | 'workbench_execution';
export type AutomationScopeType = 'project' | 'system' | 'personal';
export type AutomationRiskLevel = JobRiskLevel;

export interface CronConfig {
  type: 'daily' | 'weekdays' | 'weekly' | 'interval';
  hour?: number;
  minute?: number;
  day?: number;   // 0=Sun..6=Sat
  hours?: number; // interval mode
  minutes?: number; // interval mode (preferred)
}

export interface Automation {
  id: string;
  userId: number;
  projectId: string | null;

  name: string;
  description: string;
  prompt: string;
  model: string;
  workflow: string;

  jobType: AutomationJobType;
  scopeType: AutomationScopeType;
  definitionJson: Record<string, unknown>;
  riskLevel: AutomationRiskLevel;
  timeoutSeconds: number | null;
  timezone: string;
  createdBySessionId: string | null;
  updatedByUserId: number | null;
  configUpdatedAt: string;
  configUpdatedByUserId: number | null;
  runtimeStateJson: Record<string, unknown>;

  mode: AutomationMode;
  targetId: string | null;
  cwd: string | null;

  triggerType: AutomationTrigger;
  cronConfig: CronConfig | null;
  onceAt: string | null;

  status: AutomationStatus;
  enabled: boolean;
  sortOrder: number;

  sessionId: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runCount: number;
  lastStatus: string | null;
  lastError: string | null;

  progressSummary: string[];
  todoSnapshot: any[] | null;
  parentId: string | null;
  worktreePath: string | null;

  roomId: string | null;
  triggeredBy: number | null;
  roomMessageId: string | null;
  creatorName: string | null;

  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  status: string;
  mode: string;
  resultId: string | null;
  error: string | null;
  durationMs: number | null;
  ranAt: string;
  trigger: string;
  startedAt: string | null;
  finishedAt: string | null;
  stdoutText: string | null;
  stderrText: string | null;
  summaryText: string | null;
  errorJson: Record<string, unknown> | null;
  runnerKind: string | null;
  runnerRef: string | null;
}

export interface AutomationFilters {
  status?: AutomationStatus | AutomationStatus[];
  triggerType?: AutomationTrigger;
  projectId?: string;
  mode?: AutomationMode;
  workflow?: string;
  jobType?: AutomationJobType;
  includeArchived?: boolean;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  nameKo: string;
  description: string;
  descriptionKo: string;
  icon: string;
  defaultTrigger: AutomationTrigger;
  defaultMode: AutomationMode;
  defaultCron?: CronConfig;
  promptTemplate: string;
  category: 'research' | 'development' | 'operations' | 'communication';
}

// ── Row mapping ──

function mapRow(row: any): Automation {
  let todoSnapshot = null;
  if (row.todo_snapshot) {
    try { todoSnapshot = JSON.parse(row.todo_snapshot); } catch {}
  }
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id || null,

    name: row.name,
    description: row.description || '',
    prompt: row.prompt || '',
    model: row.model || getModelDefaults().session,
    workflow: row.workflow || 'auto',

    jobType: row.job_type || 'ai_prompt',
    scopeType: row.scope_type || (row.project_id ? 'project' : 'system'),
    definitionJson: row.definition_json || {},
    riskLevel: row.risk_level || 'low',
    timeoutSeconds: row.timeout_seconds ?? null,
    timezone: row.timezone || 'Asia/Seoul',
    createdBySessionId: row.created_by_session_id || null,
    updatedByUserId: row.updated_by_user_id || null,
    configUpdatedAt: row.config_updated_at || row.updated_at || row.created_at,
    configUpdatedByUserId: row.config_updated_by_user_id || null,
    runtimeStateJson: row.runtime_state_json || {},

    mode: row.mode || 'spawn',
    targetId: row.target_id || null,
    cwd: row.cwd || null,

    triggerType: row.trigger_type || 'manual',
    cronConfig: row.cron_config || null,
    onceAt: row.once_at || null,

    status: row.status || 'idle',
    enabled: row.enabled ?? true,
    sortOrder: row.sort_order ?? 0,

    sessionId: row.session_id || null,
    nextRunAt: row.next_run_at || null,
    lastRunAt: row.last_run_at || null,
    runCount: row.run_count || 0,
    lastStatus: row.last_status || null,
    lastError: row.last_error || null,

    progressSummary: JSON.parse(row.progress_summary || '[]'),
    todoSnapshot,
    parentId: row.parent_id || null,
    worktreePath: row.worktree_path || null,

    roomId: row.room_id || null,
    triggeredBy: row.triggered_by || null,
    roomMessageId: row.room_message_id || null,
    creatorName: row.creator_name || null,

    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null,
  };
}

function mapRunRow(row: any): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    status: row.status,
    mode: row.mode,
    resultId: row.result_id || null,
    error: row.error || null,
    durationMs: row.duration_ms ?? null,
    ranAt: row.ran_at,
    trigger: row.trigger || 'schedule',
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    stdoutText: row.stdout_text || null,
    stderrText: row.stderr_text || null,
    summaryText: row.summary_text || null,
    errorJson: row.error_json || null,
    runnerKind: row.runner_kind || null,
    runnerRef: row.runner_ref || null,
  };
}

// ── Next run calculation ──

export function calculateNextRun(cron: CronConfig, from: Date = new Date()): Date {
  const next = new Date(from);

  switch (cron.type) {
    case 'daily': {
      next.setHours(cron.hour ?? 9, cron.minute ?? 0, 0, 0);
      if (next <= from) next.setDate(next.getDate() + 1);
      return next;
    }
    case 'weekdays': {
      next.setHours(cron.hour ?? 9, cron.minute ?? 0, 0, 0);
      if (next <= from) next.setDate(next.getDate() + 1);
      while (next.getDay() === 0 || next.getDay() === 6) {
        next.setDate(next.getDate() + 1);
      }
      return next;
    }
    case 'weekly': {
      const targetDay = cron.day ?? 1;
      next.setHours(cron.hour ?? 9, cron.minute ?? 0, 0, 0);
      let daysUntil = targetDay - next.getDay();
      if (daysUntil < 0) daysUntil += 7;
      if (daysUntil === 0 && next <= from) daysUntil = 7;
      next.setDate(next.getDate() + daysUntil);
      return next;
    }
    case 'interval': {
      const minutes = cron.minutes ?? (cron.hours ?? 1) * 60;
      const intervalMs = minutes * 60 * 1000;
      return new Date(from.getTime() + intervalMs);
    }
    default:
      return new Date(from.getTime() + 3600_000);
  }
}

function applyActiveHoursWindow(nextRun: Date, automation: Automation): Date {
  const def = automation.definitionJson || {};
  const activeHours = (def as any).activeHours;
  if (!activeHours || typeof activeHours !== 'object') return nextRun;

  const startHour = Number(activeHours.startHour);
  const endHour = Number(activeHours.endHour);
  if (!Number.isFinite(startHour) || !Number.isFinite(endHour)) return nextRun;
  if (startHour < 0 || startHour > 23 || endHour < 1 || endHour > 24 || startHour >= endHour) return nextRun;

  // Tower servers for this deployment run in Asia/Seoul local time. Keep this
  // deliberately simple for interval jobs: active window is [startHour, endHour).
  const adjusted = new Date(nextRun);
  const hour = adjusted.getHours();

  if (hour < startHour) {
    adjusted.setHours(startHour, 0, 0, 0);
    return adjusted;
  }

  if (hour >= endHour) {
    adjusted.setDate(adjusted.getDate() + 1);
    adjusted.setHours(startHour, 0, 0, 0);
    return adjusted;
  }

  return adjusted;
}

function describeTrigger(triggerType: AutomationTrigger, cronConfig?: CronConfig, onceAt?: string): string {
  if (triggerType === 'once') {
    return onceAt ? `${new Date(onceAt).toLocaleString('ko-KR')}에 한 번 실행됩니다.` : '한 번 실행됩니다.';
  }
  if (triggerType === 'cron' && cronConfig) {
    const minute = String(cronConfig.minute ?? 0).padStart(2, '0');
    const hour = cronConfig.hour ?? 0;
    if (cronConfig.type === 'daily') return `매일 ${hour}:${minute}에 실행됩니다.`;
    if (cronConfig.type === 'weekdays') return `평일 ${hour}:${minute}에 실행됩니다.`;
    if (cronConfig.type === 'weekly') {
      const days = ['일', '월', '화', '수', '목', '금', '토'];
      return `매주 ${days[cronConfig.day ?? 0]}요일 ${hour}:${minute}에 실행됩니다.`;
    }
    if (cronConfig.type === 'interval') {
      const minutes = cronConfig.minutes ?? (cronConfig.hours ?? 1) * 60;
      if (minutes % 60 === 0) return `${minutes / 60}시간마다 실행됩니다.`;
      return `${minutes}분마다 실행됩니다.`;
    }
  }
  if (triggerType === 'manual') return '필요할 때 수동으로 실행됩니다.';
  return '이벤트가 발생하면 실행됩니다.';
}

function describeJobType(jobType: AutomationJobType): string {
  switch (jobType) {
    case 'ai_prompt': return 'AI 프롬프트 작업';
    case 'webhook': return '웹훅 호출 작업';
    case 'shell': return '셸 명령 작업';
    case 'script': return '스크립트 실행 작업';
    case 'monitor': return '모니터링 작업';
    case 'workbench_execution': return 'Agent Workbench 실행';
    default: return '자동화 작업';
  }
}

function getStringField(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Ensures every schedule card has a human-facing explanation, even when older
 * clients only send a raw prompt/command. The prompt remains stored separately;
 * this description explains why/when the schedule exists.
 */
export function buildDefaultAutomationDescription(data: {
  name: string;
  description?: string;
  prompt?: string;
  jobType?: AutomationJobType;
  definitionJson?: Record<string, unknown>;
  triggerType?: AutomationTrigger;
  cronConfig?: CronConfig;
  onceAt?: string;
}): string {
  const explicitDescription = data.description?.trim();
  if (explicitDescription) return explicitDescription;

  const definitionDescription = getStringField(data.definitionJson, ['description', 'summary', 'purpose', 'why']);
  if (definitionDescription) return definitionDescription;

  const jobType = data.jobType || 'ai_prompt';
  const triggerType = data.triggerType || 'manual';
  const triggerDescription = describeTrigger(triggerType, data.cronConfig, data.onceAt);
  const jobDescription = describeJobType(jobType);
  return `${data.name} 스케줄입니다. ${triggerDescription} 작업 종류는 ${jobDescription}입니다.`;
}

// ── CRUD ──

export async function createAutomation(data: {
  userId: number;
  projectId?: string;
  name: string;
  description?: string;
  prompt: string;
  model?: string;
  workflow?: string;
  jobType?: AutomationJobType;
  scopeType?: AutomationScopeType;
  definitionJson?: Record<string, unknown>;
  riskLevel?: AutomationRiskLevel;
  timeoutSeconds?: number;
  timezone?: string;
  createdBySessionId?: string;
  mode?: AutomationMode;
  targetId?: string;
  cwd?: string;
  triggerType?: AutomationTrigger;
  cronConfig?: CronConfig;
  onceAt?: string;
  parentId?: string;
  roomId?: string;
  triggeredBy?: number;
  roomMessageId?: string;
}): Promise<Automation> {
  assertNoNewInternalChannelDependency(data);
  const id = uuidv4();
  const triggerType = data.triggerType || 'manual';

  // Calculate initial next_run_at
  let nextRunAt: string | null = null;
  if (triggerType === 'once' && data.onceAt) {
    nextRunAt = new Date(data.onceAt).toISOString();
  } else if (triggerType === 'cron' && data.cronConfig) {
    nextRunAt = calculateNextRun(data.cronConfig).toISOString();
  }

  // Determine sort_order
  const maxOrder = await queryOne<any>('SELECT MAX(sort_order) as max_order FROM automations WHERE status = $1', ['idle']);
  const sortOrder = (maxOrder?.max_order ?? -1) + 1;

  // Resolve project/cwd together. If a project is explicitly provided, the
  // automation must run in that project's root unless the caller supplied an
  // explicit cwd inside that project. This prevents schedule creation from
  // mixing `project_id` from one project with the current session cwd from
  // another project.
  let resolvedProjectId = data.projectId ?? null;
  let resolvedCwd = data.cwd || null;
  if (resolvedProjectId) {
    const project = await getProject(resolvedProjectId);
    const projectRoot = project?.rootPath ? project.rootPath : null;
    if (projectRoot) {
      if (!resolvedCwd) {
        resolvedCwd = projectRoot;
      } else {
        const root = path.resolve(projectRoot);
        const cwd = path.resolve(resolvedCwd);
        if (!(cwd === root || cwd.startsWith(root + path.sep))) {
          resolvedCwd = projectRoot;
        }
      }
    }
  } else if (resolvedCwd) {
    resolvedProjectId = await resolveProjectFromCwd(resolvedCwd);
  }

  const jobType = data.jobType || 'ai_prompt';
  const scopeType = data.scopeType || (resolvedProjectId ? 'project' : 'system');
  const model = data.model || getModelDefaults().session;
  const workflow = data.workflow || 'auto';
  const mode = data.mode || 'spawn';
  const definitionJson = data.definitionJson || {
    prompt: data.prompt || '',
    mode,
    targetId: data.targetId || null,
    model,
    workflow,
    cwd: resolvedCwd || null,
  };
  const description = buildDefaultAutomationDescription({
    name: data.name,
    description: data.description,
    prompt: data.prompt,
    jobType,
    definitionJson,
    triggerType,
    cronConfig: data.cronConfig,
    onceAt: data.onceAt,
  });
  const riskLevel = data.riskLevel || classifyJobRisk(jobType, definitionJson);

  const previewAutomation = {
    definitionJson,
  } as Automation;
  if (nextRunAt) {
    nextRunAt = applyActiveHoursWindow(new Date(nextRunAt), previewAutomation).toISOString();
  }

  await execute(`
    INSERT INTO automations (
      id, user_id, project_id,
      name, description, prompt, model, workflow,
      job_type, scope_type, definition_json, risk_level, timeout_seconds, timezone, created_by_session_id,
      mode, target_id, cwd,
      trigger_type, cron_config, once_at,
      status, enabled, sort_order,
      next_run_at,
      parent_id, room_id, triggered_by, room_message_id
    ) VALUES (
      $1, $2, $3,
      $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13, $14, $15,
      $16, $17, $18,
      $19, $20, $21,
      'idle', true, $22,
      $23,
      $24, $25, $26, $27
    )
  `, [
    id, data.userId, resolvedProjectId,
    data.name, description, data.prompt || '', model, workflow,
    jobType, scopeType, JSON.stringify(definitionJson), riskLevel, data.timeoutSeconds ?? null, data.timezone || 'Asia/Seoul', data.createdBySessionId || null,
    mode, data.targetId || null, resolvedCwd || null,
    triggerType, data.cronConfig ? JSON.stringify(data.cronConfig) : null, data.onceAt || null,
    sortOrder,
    nextRunAt,
    data.parentId || null, data.roomId || null, data.triggeredBy || null, data.roomMessageId || null,
  ]);

  return (await getAutomation(id))!;
}

export async function getAutomations(userId: number, role?: string, filters?: AutomationFilters): Promise<Automation[]> {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  // Exclude archived by default
  if (!filters?.includeArchived) {
    conditions.push(`status != 'archived'`);
  }

  // Status filter
  if (filters?.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    conditions.push(`status IN (${statuses.map(() => `$${idx++}`).join(', ')})`);
    params.push(...statuses);
  }

  // Trigger filter
  if (filters?.triggerType) {
    conditions.push(`trigger_type = $${idx++}`);
    params.push(filters.triggerType);
  }

  // Project filter
  if (filters?.projectId) {
    conditions.push(`project_id = $${idx++}`);
    params.push(filters.projectId);
  }

  // Mode filter
  if (filters?.mode) {
    conditions.push(`mode = $${idx++}`);
    params.push(filters.mode);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await query<any>(
    `SELECT a.*, u.username AS creator_name
     FROM automations a
     LEFT JOIN users u ON u.id = a.user_id
     ${whereClause} ORDER BY
      CASE a.status WHEN 'running' THEN 0 WHEN 'idle' THEN 1 WHEN 'done' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END,
      a.sort_order ASC, COALESCE(a.config_updated_at, a.updated_at, a.created_at) DESC`,
    params,
  );

  // Permission scoping
  if (userId && role) {
    const accessibleIds = await getAccessibleProjectIds(userId, role);
    if (accessibleIds !== null) {
      // Member: project automations by group, non-project automations by creator
      return rows.filter((r: any) => {
        if (!r.project_id) return r.user_id === userId;
        return accessibleIds.includes(r.project_id);
      }).map(mapRow);
    }
    // admin / operator → all automations visible
    return rows.map(mapRow);
  }

  // No auth context: filter by user_id
  if (userId) {
    return rows.filter((r: any) => r.user_id === userId || r.user_id === null).map(mapRow);
  }
  return rows.map(mapRow);
}

type AutomationDb = {
  queryOne<T = any>(sql: string, params?: any[]): Promise<T | undefined>;
  execute(sql: string, params?: any[]): Promise<{ changes: number }>;
};

const defaultAutomationDb: AutomationDb = { queryOne, execute };

async function getAutomationWithDb(db: AutomationDb, id: string): Promise<Automation | null> {
  const row = await db.queryOne<any>('SELECT * FROM automations WHERE id = $1', [id]);
  return row ? mapRow(row) : null;
}

export async function getAutomation(id: string): Promise<Automation | null> {
  return getAutomationWithDb(defaultAutomationDb, id);
}

export async function getAutomationInTransaction(client: PoolClient, id: string): Promise<Automation | null> {
  return getAutomationWithDb(withClient(client), id);
}

export async function getAutomationForUpdateInTransaction(client: PoolClient, id: string): Promise<Automation | null> {
  const row = await withClient(client).queryOne<any>('SELECT * FROM automations WHERE id = $1 FOR UPDATE', [id]);
  return row ? mapRow(row) : null;
}

async function updateAutomationWithDb(db: AutomationDb, id: string, updates: Partial<{
  name: string;
  description: string;
  prompt: string;
  model: string;
  workflow: string;
  jobType: AutomationJobType;
  scopeType: AutomationScopeType;
  definitionJson: Record<string, unknown>;
  riskLevel: AutomationRiskLevel;
  timeoutSeconds: number | null;
  timezone: string;
  createdBySessionId: string | null;
  updatedByUserId: number | null;
  configUpdatedByUserId: number | null;
  runtimeStateJson: Record<string, unknown>;
  mode: AutomationMode;
  targetId: string | null;
  cwd: string | null;
  triggerType: AutomationTrigger;
  cronConfig: CronConfig | null;
  onceAt: string | null;
  status: AutomationStatus;
  enabled: boolean;
  sortOrder: number;
  sessionId: string | null;
  progressSummary: string[];
  todoSnapshot: any[] | null;
  completedAt: string | null;
  parentId: string | null;
  worktreePath: string | null;
  projectId: string | null;
  roomId: string | null;
  triggeredBy: number | null;
  roomMessageId: string | null;
  lastRunAt: string | null;
  runCount: number;
  lastStatus: string | null;
  lastError: string | null;
}>): Promise<Automation | null> {
  assertNoNewInternalChannelDependency(updates);
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  const addField = (col: string, val: any) => {
    fields.push(`${col} = $${paramIndex++}`);
    values.push(val);
  };

  const touchesConfig = [
    'name', 'description', 'prompt', 'model', 'workflow', 'jobType', 'scopeType',
    'definitionJson', 'riskLevel', 'timeoutSeconds', 'timezone', 'mode', 'targetId',
    'cwd', 'triggerType', 'cronConfig', 'onceAt', 'enabled', 'sortOrder', 'completedAt',
    'parentId', 'worktreePath', 'projectId', 'roomId', 'triggeredBy', 'roomMessageId',
  ].some((key) => (updates as any)[key] !== undefined);

  if (updates.name !== undefined) addField('name', updates.name);
  if (updates.description !== undefined) addField('description', updates.description);
  if (updates.prompt !== undefined) addField('prompt', updates.prompt);
  if (updates.model !== undefined) addField('model', updates.model);
  if (updates.workflow !== undefined) addField('workflow', updates.workflow);
  if (updates.jobType !== undefined) addField('job_type', updates.jobType);
  if (updates.scopeType !== undefined) addField('scope_type', updates.scopeType);
  if (updates.definitionJson !== undefined) addField('definition_json', JSON.stringify(updates.definitionJson));
  if (updates.riskLevel !== undefined) addField('risk_level', updates.riskLevel);
  if (updates.timeoutSeconds !== undefined) addField('timeout_seconds', updates.timeoutSeconds);
  if (updates.timezone !== undefined) addField('timezone', updates.timezone);
  if (updates.createdBySessionId !== undefined) addField('created_by_session_id', updates.createdBySessionId);
  if (updates.updatedByUserId !== undefined) {
    addField('updated_by_user_id', updates.updatedByUserId);
    if (touchesConfig) addField('config_updated_by_user_id', updates.updatedByUserId);
  }
  if (updates.runtimeStateJson !== undefined) addField('runtime_state_json', JSON.stringify(updates.runtimeStateJson));
  if (updates.mode !== undefined) addField('mode', updates.mode);
  if (updates.targetId !== undefined) addField('target_id', updates.targetId);
  if (updates.cwd !== undefined) addField('cwd', updates.cwd);
  if (updates.triggerType !== undefined) addField('trigger_type', updates.triggerType);
  if (updates.cronConfig !== undefined) addField('cron_config', updates.cronConfig ? JSON.stringify(updates.cronConfig) : null);
  if (updates.onceAt !== undefined) addField('once_at', updates.onceAt);
  if (updates.status !== undefined) addField('status', updates.status);
  if (updates.enabled !== undefined) addField('enabled', updates.enabled);
  if (updates.sortOrder !== undefined) addField('sort_order', updates.sortOrder);
  if (updates.sessionId !== undefined) addField('session_id', updates.sessionId);
  if (updates.progressSummary !== undefined) addField('progress_summary', JSON.stringify(updates.progressSummary));
  if (updates.todoSnapshot !== undefined) addField('todo_snapshot', updates.todoSnapshot ? JSON.stringify(updates.todoSnapshot) : null);
  if (updates.completedAt !== undefined) addField('completed_at', updates.completedAt);
  if (updates.parentId !== undefined) addField('parent_id', updates.parentId);
  if (updates.worktreePath !== undefined) addField('worktree_path', updates.worktreePath);
  if (updates.projectId !== undefined) addField('project_id', updates.projectId);
  if (updates.roomId !== undefined) addField('room_id', updates.roomId);
  if (updates.triggeredBy !== undefined) addField('triggered_by', updates.triggeredBy);
  if (updates.roomMessageId !== undefined) addField('room_message_id', updates.roomMessageId);
  if (updates.lastRunAt !== undefined) addField('last_run_at', updates.lastRunAt);
  if (updates.runCount !== undefined) addField('run_count', updates.runCount);
  if (updates.lastStatus !== undefined) addField('last_status', updates.lastStatus);
  if (updates.lastError !== undefined) addField('last_error', updates.lastError);

  if (fields.length === 0) return getAutomationWithDb(db, id);

  // Recalculate next_run_at if schedule parameters changed
  if (updates.triggerType !== undefined || updates.cronConfig !== undefined || updates.onceAt !== undefined || updates.enabled !== undefined) {
    const existing = await getAutomationWithDb(db, id);
    if (existing) {
      const triggerType = updates.triggerType ?? existing.triggerType;
      const cronConfig = updates.cronConfig !== undefined ? updates.cronConfig : existing.cronConfig;
      const onceAt = updates.onceAt !== undefined ? updates.onceAt : existing.onceAt;
      const enabled = updates.enabled ?? existing.enabled;

      let nextRunAt: string | null = null;
      if (enabled) {
        if (triggerType === 'once' && onceAt) {
          nextRunAt = new Date(onceAt).toISOString();
        } else if (triggerType === 'cron' && cronConfig) {
          nextRunAt = calculateNextRun(cronConfig).toISOString();
        }
      }
      addField('next_run_at', nextRunAt);
    }
  }

  if (touchesConfig) addField('config_updated_at', new Date().toISOString());
  addField('updated_at', new Date().toISOString());
  values.push(id);

  await db.execute(`UPDATE automations SET ${fields.join(', ')} WHERE id = $${paramIndex}`, values);
  return getAutomationWithDb(db, id);
}

export async function updateAutomation(id: string, updates: Parameters<typeof updateAutomationWithDb>[2]): Promise<Automation | null> {
  return updateAutomationWithDb(defaultAutomationDb, id, updates);
}

export async function updateAutomationInTransaction(client: PoolClient, id: string, updates: Parameters<typeof updateAutomationWithDb>[2]): Promise<Automation | null> {
  return updateAutomationWithDb(withClient(client), id, updates);
}

export async function deleteAutomation(id: string): Promise<boolean> {
  // Soft-delete: archive
  const result = await execute(
    `UPDATE automations SET status = 'archived', config_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [id],
  );
  return result.changes > 0;
}

export async function permanentlyDeleteAutomation(id: string): Promise<boolean> {
  const result = await execute('DELETE FROM automations WHERE id = $1', [id]);
  return result.changes > 0;
}

export async function restoreAutomation(id: string): Promise<boolean> {
  const result = await execute(
    `UPDATE automations SET status = 'idle', config_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'archived'`,
    [id],
  );
  return result.changes > 0;
}

export async function getChildAutomations(parentId: string): Promise<Automation[]> {
  const rows = await query<any>(
    `SELECT * FROM automations WHERE parent_id = $1 AND status != 'archived' ORDER BY sort_order`,
    [parentId],
  );
  return rows.map(mapRow);
}

export async function reorderAutomations(automationIds: string[], status: string): Promise<void> {
  // Map frontend status → automation status
  const mappedStatus = status === 'todo' ? 'idle' : status === 'in_progress' ? 'running' : status;

  await transaction(async (client) => {
    const db = withClient(client);
    for (let i = 0; i < automationIds.length; i++) {
      await db.execute(
        'UPDATE automations SET sort_order = $1, status = $2, config_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [i, mappedStatus, automationIds[i]],
      );
    }
  });
}

export async function getArchivedAutomations(userId?: number): Promise<Automation[]> {
  const rows = userId
    ? await query<any>(`SELECT * FROM automations WHERE user_id = $1 AND status = 'archived' ORDER BY updated_at DESC`, [userId])
    : await query<any>(`SELECT * FROM automations WHERE status = 'archived' ORDER BY updated_at DESC`);
  return rows.map(mapRow);
}

// ── Run history ──

export async function getAutomationRuns(automationId: string, limit = 20): Promise<AutomationRun[]> {
  const rows = await query<any>(
    'SELECT * FROM automation_runs WHERE automation_id = $1 ORDER BY ran_at DESC LIMIT $2',
    [automationId, limit],
  );
  return rows.map(mapRunRow);
}

export async function logRun(params: {
  automationId: string;
  status: string;
  mode: string;
  resultId: string | null;
  error: string | null;
  durationMs: number;
  trigger?: string;
  startedAt?: string;
  finishedAt?: string;
  stdoutText?: string | null;
  stderrText?: string | null;
  summaryText?: string | null;
  errorJson?: Record<string, unknown> | null;
  runnerKind?: string | null;
  runnerRef?: string | null;
}): Promise<string> {
  const id = uuidv4();
  await execute(`
    INSERT INTO automation_runs (
      id, automation_id, status, mode, result_id, error, duration_ms,
      trigger, started_at, finished_at, stdout_text, stderr_text, summary_text, error_json, runner_kind, runner_ref
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13, $14, $15, $16
    )
  `, [
    id, params.automationId, params.status, params.mode, params.resultId, params.error, params.durationMs,
    params.trigger || 'schedule', params.startedAt || null, params.finishedAt || null,
    params.stdoutText || null, params.stderrText || null, params.summaryText || null,
    params.errorJson ? JSON.stringify(params.errorJson) : null, params.runnerKind || null, params.runnerRef || null,
  ]);
  return id;
}

// ── Schedule advancement ──

export async function recordAutomationRuntimeResult(automationId: string, status: string, error: string | null): Promise<void> {
  await execute(`
    UPDATE automations
    SET last_run_at = NOW(), run_count = run_count + 1,
        last_status = $1, last_error = $2
    WHERE id = $3
  `, [status, error, automationId]);
}

export async function advanceSchedule(automation: Automation, status: string, error: string | null): Promise<void> {
  if (automation.triggerType === 'once') {
    await execute(`
      UPDATE automations
      SET enabled = false, last_run_at = NOW(), run_count = run_count + 1,
          last_status = $1, last_error = $2
      WHERE id = $3
    `, [status, error, automation.id]);
  } else if (automation.triggerType === 'cron' && automation.cronConfig) {
    const nextRun = applyActiveHoursWindow(calculateNextRun(automation.cronConfig), automation);
    await execute(`
      UPDATE automations
      SET next_run_at = CASE WHEN enabled = false THEN NULL ELSE $1::timestamptz END,
          last_run_at = NOW(), run_count = run_count + 1,
          last_status = $2, last_error = $3
      WHERE id = $4
    `, [nextRun.toISOString(), status, error, automation.id]);
  }
}

// ── Project resolution (from task-manager) ──

export async function resolveProjectFromCwd(cwd: string): Promise<string | null> {
  const projects = await query<{ id: string; root_path: string }>(
    'SELECT id, root_path FROM projects WHERE root_path IS NOT NULL AND (archived IS NULL OR archived = 0)'
  );
  let bestMatch: string | null = null;
  let bestLen = 0;
  for (const p of projects) {
    const rp = p.root_path.endsWith('/') ? p.root_path.slice(0, -1) : p.root_path;
    if ((cwd === rp || cwd.startsWith(rp + '/')) && rp.length > bestLen) {
      bestMatch = p.id;
      bestLen = rp.length;
    }
  }
  return bestMatch;
}

export async function backfillAutomationProjects(): Promise<{ updated: number; total: number }> {
  const orphans = await query<{ id: string; cwd: string }>(
    `SELECT id, cwd FROM automations WHERE project_id IS NULL AND cwd IS NOT NULL AND status != 'archived'`
  );
  let updated = 0;
  for (const a of orphans) {
    const projectId = await resolveProjectFromCwd(a.cwd);
    if (projectId) {
      await execute('UPDATE automations SET project_id = $1, config_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [projectId, a.id]);
      updated++;
    }
  }
  return { updated, total: orphans.length };
}

// ── Distinct CWDs (for UI filters) ──

export async function getDistinctCwds(userId?: number): Promise<string[]> {
  const rows = userId
    ? await query<any>('SELECT DISTINCT cwd FROM automations WHERE user_id = $1 AND cwd IS NOT NULL ORDER BY cwd', [userId])
    : await query<any>('SELECT DISTINCT cwd FROM automations WHERE cwd IS NOT NULL ORDER BY cwd');
  return rows.map((r: any) => r.cwd);
}

// ── Workflow Templates ──

const TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'research',
    name: 'Research',
    nameKo: '리서치',
    description: 'Deep research on a topic with web search and summary report',
    descriptionKo: '주제에 대해 웹 검색 + 요약 리포트 생성',
    icon: '🔍',
    defaultTrigger: 'manual',
    defaultMode: 'spawn',
    promptTemplate: '다음 주제에 대해 심층 리서치를 진행하세요:\n\n{{topic}}\n\n웹 검색으로 최신 정보를 수집하고, 핵심 발견사항을 요약 리포트로 정리해주세요.',
    category: 'research',
  },
  {
    id: 'monitoring',
    name: 'Monitoring',
    nameKo: '모니터링',
    description: 'Periodic status check with anomaly alerts',
    descriptionKo: 'URL/서비스 상태를 주기적으로 확인하고 이상 시 알림',
    icon: '📊',
    defaultTrigger: 'cron',
    defaultMode: 'channel',
    defaultCron: { type: 'interval', hours: 1 },
    promptTemplate: '다음 서비스/URL의 상태를 확인하세요:\n\n{{target}}\n\n정상이면 간단히 보고, 이상이 있으면 상세히 알려주세요.',
    category: 'operations',
  },
  {
    id: 'code-impl',
    name: 'Code Implementation',
    nameKo: '코드 구현',
    description: 'Implement features based on requirements',
    descriptionKo: '요구사항 기반 코드 작성 + 테스트',
    icon: '🏗',
    defaultTrigger: 'manual',
    defaultMode: 'spawn',
    promptTemplate: '다음 요구사항을 구현하세요:\n\n{{requirements}}\n\n코드 작성 후 테스트도 함께 작성해주세요.',
    category: 'development',
  },
  {
    id: 'daily-briefing',
    name: 'Daily Briefing',
    nameKo: '데일리 브리핑',
    description: 'Daily project status summary',
    descriptionKo: '매일 프로젝트 현황 + 할일 요약',
    icon: '📰',
    defaultTrigger: 'cron',
    defaultMode: 'inject',
    defaultCron: { type: 'daily', hour: 9, minute: 0 },
    promptTemplate: '오늘의 프로젝트 현황을 브리핑해주세요:\n\n1. 어제 완료된 작업\n2. 오늘 해야 할 작업\n3. 블로커나 주의사항\n\n간결하게 정리해주세요.',
    category: 'operations',
  },
  {
    id: 'report',
    name: 'Report Generation',
    nameKo: '보고서 생성',
    description: 'Data analysis and document generation',
    descriptionKo: '데이터 분석 + 문서 생성',
    icon: '📋',
    defaultTrigger: 'manual',
    defaultMode: 'spawn',
    promptTemplate: '다음 데이터/주제에 대한 보고서를 작성하세요:\n\n{{subject}}\n\n분석 결과와 인사이트를 포함해주세요.',
    category: 'research',
  },
  {
    id: 'team-notify',
    name: 'Team Notification',
    nameKo: '팀 알림',
    description: 'Send periodic notifications to a channel',
    descriptionKo: '채널에 정기 알림 메시지 전송',
    icon: '🔔',
    defaultTrigger: 'cron',
    defaultMode: 'channel',
    defaultCron: { type: 'weekly', day: 1, hour: 10, minute: 0 },
    promptTemplate: '팀에게 다음 내용을 알려주세요:\n\n{{message}}',
    category: 'communication',
  },
  {
    id: 'code-review',
    name: 'Code Review',
    nameKo: '코드 리뷰',
    description: 'Analyze code changes and suggest improvements',
    descriptionKo: 'PR/diff 분석 + 개선점 제안',
    icon: '🔎',
    defaultTrigger: 'manual',
    defaultMode: 'spawn',
    promptTemplate: '다음 코드 변경사항을 리뷰해주세요:\n\n{{target}}\n\n버그, 성능, 가독성 관점에서 개선점을 제안해주세요.',
    category: 'development',
  },
  {
    id: 'data-pipeline',
    name: 'Data Pipeline',
    nameKo: '데이터 파이프라인',
    description: 'Periodic data collection and processing',
    descriptionKo: '정기 데이터 수집/가공',
    icon: '⚙️',
    defaultTrigger: 'cron',
    defaultMode: 'spawn',
    defaultCron: { type: 'daily', hour: 6, minute: 0 },
    promptTemplate: '다음 데이터 파이프라인을 실행하세요:\n\n{{pipeline}}\n\n수집 → 변환 → 저장 순서로 진행해주세요.',
    category: 'operations',
  },
];

export function getTemplates(): WorkflowTemplate[] {
  return TEMPLATES;
}

export async function createFromTemplate(
  templateId: string,
  userId: number,
  overrides?: Partial<{
    name: string;
    prompt: string;
    model: string;
    projectId: string;
    cwd: string;
    triggerType: AutomationTrigger;
    cronConfig: CronConfig;
    mode: AutomationMode;
    targetId: string;
  }>,
): Promise<Automation> {
  const template = TEMPLATES.find(t => t.id === templateId);
  if (!template) throw new Error(`Template not found: ${templateId}`);

  return createAutomation({
    userId,
    name: overrides?.name || template.nameKo,
    description: template.descriptionKo,
    prompt: overrides?.prompt || template.promptTemplate,
    model: overrides?.model || getModelDefaults().session,
    workflow: templateId,
    mode: overrides?.mode || template.defaultMode,
    targetId: overrides?.targetId,
    cwd: overrides?.cwd,
    triggerType: overrides?.triggerType || template.defaultTrigger,
    cronConfig: overrides?.cronConfig || template.defaultCron,
    projectId: overrides?.projectId,
  });
}

// ── Backward-compatible helpers (for task-runner.ts migration) ──

/** Create a spawn-mode automation (replaces createTask) */
export async function createSpawnAutomation(
  title: string,
  description: string,
  cwd: string,
  userId?: number,
  model?: string,
  workflow?: string,
  parentId?: string,
  projectId?: string,
  roomInfo?: { roomId: string; triggeredBy: number; roomMessageId: string },
): Promise<Automation> {
  return createAutomation({
    userId: userId ?? 1,
    name: title,
    description,
    prompt: description || title,
    model,
    workflow,
    mode: 'spawn',
    cwd,
    triggerType: 'manual',
    parentId,
    projectId,
    roomId: roomInfo?.roomId,
    triggeredBy: roomInfo?.triggeredBy,
    roomMessageId: roomInfo?.roomMessageId,
  });
}
