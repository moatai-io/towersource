/**
 * Owns: canonical WorkLedger / RunLedger records for trackable Tower work.
 * Public API: upsertWorkLedgerRecord(), finalizeSessionWorkLedgerRecords(), listWorkLedgerRecords().
 * See: workspace/decisions/2026-07-01-process-map-as-automation-seed.md
 */

import { query } from '../../db/pg-repo.js';
import { reconcileSessionProjectAgentCareer } from '../agents/agent-career-promotion.js';

export type WorkLedgerSourceType = 'command_invocation' | 'process_map' | 'todowrite' | 'schedule_run' | 'agent_run' | 'manual';
export type WorkLedgerStatus = 'running' | 'completed' | 'blocked' | 'failed' | 'cancelled';

export interface WorkLedgerBacklogItem {
  type?: string;
  title: string;
  priority?: string;
  reason?: string;
}

export interface WorkLedgerQuestion {
  title: string;
  status?: string;
  reason?: string;
}

export interface WorkLedgerTodoItem {
  content: string;
  status: string;
  activeForm?: string;
}

export interface WorkLedgerRecord {
  id: string;
  runId: string;
  projectId: string | null;
  sessionId: string | null;
  ownerUserId: number | null;
  agentName?: string | null;
  agentFace?: string | null;
  workstreamKey: string;
  workstreamTitle: string | null;
  runTitle: string;
  outcome: string | null;
  note: string | null;
  sourceType: WorkLedgerSourceType;
  sourceId: string | null;
  sourceRefs: Record<string, unknown>;
  status: WorkLedgerStatus;
  artifacts: string[];
  backlog: WorkLedgerBacklogItem[];
  questions: WorkLedgerQuestion[];
  todos: WorkLedgerTodoItem[];
  activityAt: string;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkLedgerInput {
  runId: string;
  projectId?: string | null;
  sessionId?: string | null;
  ownerUserId?: number | null;
  workstreamKey: string;
  workstreamTitle?: string | null;
  runTitle: string;
  outcome?: string | null;
  note?: string | null;
  sourceType: WorkLedgerSourceType;
  sourceId?: string | null;
  sourceRefs?: Record<string, unknown>;
  status?: WorkLedgerStatus;
  artifacts?: string[];
  backlog?: WorkLedgerBacklogItem[];
  questions?: WorkLedgerQuestion[];
  todos?: WorkLedgerTodoItem[];
  activityAt?: string;
  startedAt?: string;
  completedAt?: string | null;
}

function mapWorkLedgerRow(row: any): WorkLedgerRecord {
  return {
    id: row.id,
    runId: row.run_id,
    projectId: row.project_id || null,
    sessionId: row.session_id || null,
    ownerUserId: row.owner_user_id ?? null,
    workstreamKey: row.workstream_key,
    workstreamTitle: row.workstream_title || null,
    runTitle: row.run_title,
    outcome: row.outcome || null,
    note: row.note || null,
    sourceType: row.source_type,
    sourceId: row.source_id || null,
    sourceRefs: row.source_refs || {},
    status: row.status,
    artifacts: Array.isArray(row.artifacts) ? row.artifacts : [],
    backlog: Array.isArray(row.backlog) ? row.backlog : [],
    questions: Array.isArray(row.questions) ? row.questions : [],
    todos: Array.isArray(row.todos) ? row.todos : [],
    activityAt: row.activity_at || row.started_at || row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function compactString(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function assertRequiredString(name: string, value: string): string {
  const compact = compactString(value || '');
  if (!compact) throw new Error(`work ledger ${name} is required`);
  return compact;
}

function cleanStringArray(value: string[] | undefined): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : [];
}

function cleanBacklog(value: WorkLedgerBacklogItem[] | undefined): WorkLedgerBacklogItem[] {
  return Array.isArray(value)
    ? value.map((item) => ({
      type: item.type?.trim() || undefined,
      title: item.title?.trim() || '',
      priority: item.priority?.trim() || undefined,
      reason: item.reason?.trim() || undefined,
    })).filter((item) => item.title.length > 0)
    : [];
}

function cleanTodos(value: WorkLedgerTodoItem[] | undefined): WorkLedgerTodoItem[] {
  return Array.isArray(value)
    ? value.map((item) => ({
      content: item.content?.trim() || '',
      status: item.status?.trim() || 'pending',
      activeForm: item.activeForm?.trim() || undefined,
    })).filter((item) => item.content.length > 0)
    : [];
}

function cleanQuestions(value: WorkLedgerQuestion[] | undefined): WorkLedgerQuestion[] {
  return Array.isArray(value)
    ? value.map((item) => ({
      title: item.title?.trim() || '',
      status: item.status?.trim() || undefined,
      reason: item.reason?.trim() || undefined,
    })).filter((item) => item.title.length > 0)
    : [];
}

/**
 * Insert or update the canonical work ledger record for a source/run pair.
 * This is intentionally independent of TodoWrite so Process Map only runs can
 * appear in My Work without duplicate tool calls.
 */
export async function upsertWorkLedgerRecord(input: WorkLedgerInput): Promise<WorkLedgerRecord> {
  const runId = assertRequiredString('runId', input.runId);
  const workstreamKey = assertRequiredString('workstreamKey', input.workstreamKey);
  const runTitle = assertRequiredString('runTitle', input.runTitle);
  const status = input.status || 'running';
  const completedAt = input.completedAt ?? (status === 'completed' || status === 'failed' || status === 'cancelled' ? new Date().toISOString() : null);

  const rows = await query<any>(`
    WITH previous AS (
      SELECT status
        FROM work_ledger_records
       WHERE run_id=$1 AND source_type=$10 AND source_id=COALESCE($11, '')
       FOR UPDATE
    ), upserted AS (
      INSERT INTO work_ledger_records (
        run_id, project_id, session_id, owner_user_id,
        workstream_key, workstream_title, run_title, outcome, note,
        source_type, source_id, source_refs, status,
        artifacts, backlog, questions, todos, activity_at, started_at, completed_at
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8, $9,
        $10, COALESCE($11, ''), $12::jsonb, $13,
        $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb,
        COALESCE($18::timestamptz, $19::timestamptz, NOW()), COALESCE($19::timestamptz, NOW()), $20::timestamptz
      )
      ON CONFLICT (run_id, source_type, source_id) DO UPDATE SET
        project_id = EXCLUDED.project_id,
        session_id = EXCLUDED.session_id,
        owner_user_id = EXCLUDED.owner_user_id,
        workstream_key = EXCLUDED.workstream_key,
        workstream_title = EXCLUDED.workstream_title,
        run_title = EXCLUDED.run_title,
        outcome = EXCLUDED.outcome,
        note = EXCLUDED.note,
        source_refs = EXCLUDED.source_refs,
        status = EXCLUDED.status,
        artifacts = EXCLUDED.artifacts,
        backlog = EXCLUDED.backlog,
        questions = EXCLUDED.questions,
        todos = EXCLUDED.todos,
        activity_at = EXCLUDED.activity_at,
        completed_at = COALESCE(EXCLUDED.completed_at, work_ledger_records.completed_at)
      RETURNING *
    )
    SELECT upserted.*,
           ($13='completed' AND NOT EXISTS (SELECT 1 FROM previous WHERE status='completed')) AS became_completed
      FROM upserted
  `, [
    runId,
    input.projectId || null,
    input.sessionId || null,
    input.ownerUserId ?? null,
    workstreamKey,
    input.workstreamTitle ? compactString(input.workstreamTitle) : null,
    runTitle,
    input.outcome ? compactString(input.outcome) : null,
    input.note ? compactString(input.note) : null,
    input.sourceType,
    input.sourceId || null,
    JSON.stringify(input.sourceRefs || {}),
    status,
    JSON.stringify(cleanStringArray(input.artifacts)),
    JSON.stringify(cleanBacklog(input.backlog)),
    JSON.stringify(cleanQuestions(input.questions)),
    JSON.stringify(cleanTodos(input.todos)),
    input.activityAt || null,
    input.startedAt || null,
    completedAt,
  ]);
  const row = rows[0];
  if (row?.became_completed && row.session_id) {
    try {
      await reconcileSessionProjectAgentCareer(row.session_id);
    } catch (error) {
      console.error('[work-ledger] Agent career reconciliation failed:', error);
    }
  }
  return mapWorkLedgerRow(row);
}

export type WorkLedgerTerminalOutcome = 'completed' | 'failed';

/**
 * Finalize only Work Ledger rows touched during the current turn.
 *
 * Conservative contract (no DB status migration):
 * - error/aborted terminal outcome marks current-turn running rows failed;
 * - successful terminal outcome completes rows only when every persisted todo is completed;
 * - successful rows with unfinished todos remain running for the stale projection safety net.
 */
export async function finalizeSessionWorkLedgerRecords(input: {
  sessionId: string;
  turnStartedAt: string;
  outcome: WorkLedgerTerminalOutcome;
  completedAt?: string;
}): Promise<number> {
  const sessionId = assertRequiredString('sessionId', input.sessionId);
  const turnStartedAt = assertRequiredString('turnStartedAt', input.turnStartedAt);
  const completedAt = input.completedAt || new Date().toISOString();
  const terminalCondition = input.outcome === 'failed'
    ? 'TRUE'
    : `jsonb_array_length(todos) > 0
       AND NOT EXISTS (
         SELECT 1
         FROM jsonb_array_elements(todos) AS todo
         WHERE COALESCE(todo->>'status', 'pending') <> 'completed'
       )`;
  const status: WorkLedgerStatus = input.outcome === 'failed' ? 'failed' : 'completed';
  const rows = await query<{ id: string }>(`
    UPDATE work_ledger_records
       SET status = $3,
           completed_at = $4::timestamptz
     WHERE session_id = $1
       AND status = 'running'
       AND activity_at >= $2::timestamptz
       AND (${terminalCondition})
    RETURNING id
  `, [sessionId, turnStartedAt, status, completedAt]);
  if (status === 'completed' && rows.length > 0) {
    try {
      await reconcileSessionProjectAgentCareer(sessionId);
    } catch (error) {
      console.error('[work-ledger] Agent career reconciliation failed:', error);
    }
  }
  return rows.length;
}

/** List canonical ledger rows. Used by My Work projections before TodoWrite fallback. */
export async function listWorkLedgerRecords(args: {
  start: Date;
  end: Date;
  projectId?: string | null;
  ownerUserId?: number | null;
  accessibleProjectIds?: string[] | null;
  requesterUserId: number;
  privileged: boolean;
  limit: number;
}): Promise<WorkLedgerRecord[]> {
  const conditions: string[] = [
    'w.activity_at >= $1',
    'w.activity_at <= $2',
    '(p.archived IS NULL OR p.archived = 0)',
  ];
  const values: any[] = [args.start.toISOString(), args.end.toISOString()];

  if (args.projectId && args.projectId !== 'all') {
    values.push(args.projectId);
    conditions.push(`w.project_id = $${values.length}`);
  }
  if (args.ownerUserId && Number.isFinite(args.ownerUserId)) {
    if (args.privileged || args.ownerUserId === args.requesterUserId) {
      values.push(args.ownerUserId);
      conditions.push(`w.owner_user_id = $${values.length}`);
    }
  }
  if (!args.privileged) {
    values.push(args.requesterUserId);
    const ownParam = values.length;
    values.push(args.accessibleProjectIds || []);
    const projectsParam = values.length;
    conditions.push(`(
      w.owner_user_id = $${ownParam}
      OR (w.project_id = ANY($${projectsParam}::text[]) AND w.project_id IS NOT NULL)
    )`);
  }

  values.push(args.limit);
  const rows = await query<any>(`
    SELECT
      w.*,
      COALESCE(p.name, 'No project') AS project_name,
      COALESCE(u.display_name, u.username, 'unknown') AS owner_name,
      COALESCE(s.project_agent_profile_snapshot->>'displayName', pap.display_name, p.name, 'AI 팀원') AS agent_name,
      COALESCE(s.project_agent_profile_snapshot->>'face', pap.face) AS agent_face
    FROM work_ledger_records w
    LEFT JOIN projects p ON p.id = w.project_id
    LEFT JOIN sessions s ON s.id = w.session_id
    LEFT JOIN project_agent_profiles pap ON pap.project_id = w.project_id
    LEFT JOIN users u ON u.id = w.owner_user_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY w.activity_at DESC
    LIMIT $${values.length}
  `, values);

  return rows.map((row) => ({
    ...mapWorkLedgerRow(row),
    projectName: row.project_name || 'No project',
    ownerName: row.owner_name || 'unknown',
    agentName: row.agent_name || row.project_name || 'AI 팀원',
    agentFace: row.agent_face || null,
  } as WorkLedgerRecord & { projectName: string; ownerName: string; agentName: string; agentFace: string | null }));
}
