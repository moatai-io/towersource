/**
 * Owns: read-only Challenge Timeline projection from stored TodoWrite snapshots.
 * Public API: getChallengeTimeline(). See README.md.
 */
import { query } from '../../db/pg-repo.js';
import { getAccessibleProjectIds } from '../pm/project-membership-manager.js';
import { listWorkLedgerRecords, type WorkLedgerRecord } from './work-ledger.js';

export interface ChallengeTimelineParams {
  userId: number;
  role: string;
  rangeHours?: number;
  bucketHours?: number;
  projectId?: string | null;
  ownerUserId?: number | null;
  limitChallenges?: number;
}

export interface ChallengeTimelineSegment {
  start: string;
  end: string;
  kind: 'work' | 'active' | 'done';
  snapshotCount: number;
}

export interface ChallengeTimelineFollowUpItem {
  type?: string;
  title: string;
  priority?: string;
  reason?: string;
}

export interface ChallengeTimelineQuestion {
  title: string;
  status?: string;
  reason?: string;
}

export interface ChallengeTimelineSession {
  id: string;
  name: string;
  owner: string;
  agentName: string;
  agentFace: string | null;
  projectId: string | null;
  projectName: string;
  lastAt: string;
  snapshotCount: number;
  todoTotal: number;
  todoDone: number;
  todoLeft: number;
  runTitles: string[];
  openTodos: Array<{ content: string; status: string }>;
  completedTodos: Array<{ content: string; status: string }>;
}

export type ChallengeTimelineWaitingReason = 'stale' | 'blocked' | 'failed' | 'unfinished' | null;

export interface ChallengeTimelineRow {
  id: string;
  title: string;
  workstreamKey: string;
  runTitles: string[];
  outcomes: string[];
  projectId: string | null;
  projectName: string;
  owners: string[];
  sessionCount: number;
  todoTotal: number;
  todoDone: number;
  todoLeft: number;
  backlog: ChallengeTimelineFollowUpItem[];
  questions: ChallengeTimelineQuestion[];
  sessions: ChallengeTimelineSession[];
  status: 'active' | 'waiting' | 'resolved';
  waitingReason: ChallengeTimelineWaitingReason;
  lastAt: string;
  segments: ChallengeTimelineSegment[];
}

export interface ChallengeTimelineProject {
  id: string | null;
  name: string;
  challengeCount: number;
  todoLeft: number;
  challenges: ChallengeTimelineRow[];
}

export interface ChallengeTimelineResult {
  rangeHours: number;
  bucketHours: number;
  start: string;
  end: string;
  ticks: string[];
  projects: ChallengeTimelineProject[];
  totals: {
    projects: number;
    challenges: number;
    todoLeft: number;
    snapshots: number;
  };
}

interface TodoSnapshot {
  sessionId: string;
  sessionName: string;
  projectId: string | null;
  projectName: string;
  ownerUserId: number | null;
  ownerName: string;
  agentName: string;
  agentFace: string | null;
  at: Date;
  workstreamKey: string;
  workstreamTitle: string;
  runTitle: string | null;
  outcome: string | null;
  todos: Array<{ content: string; status: string }>;
  backlog: Array<{ type?: string; title: string; priority?: string; reason?: string }>;
  questions: Array<{ title: string; status?: string; reason?: string }>;
  runStatus?: 'running' | 'completed' | 'blocked' | 'failed' | 'cancelled';
  source?: 'todowrite' | 'work_ledger';
}

const STALE_RUNNING_AFTER_MS = 7 * 24 * 60 * 60_000;

function isFreshActivity(at: Date, reference: Date): boolean {
  return at.getTime() >= reference.getTime() - STALE_RUNNING_AFTER_MS;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value || NaN)) return fallback;
  return Math.min(Math.max(Math.trunc(value as number), min), max);
}

function ceilToBucket(date: Date, bucketHours: number): Date {
  const next = new Date(date);
  next.setMinutes(0, 0, 0);
  if (date.getMinutes() || date.getSeconds() || date.getMilliseconds()) next.setHours(next.getHours() + 1);
  const mod = next.getHours() % bucketHours;
  if (mod !== 0) next.setHours(next.getHours() + (bucketHours - mod));
  return next;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function humanizeKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b[a-z]/g, (match) => match.toUpperCase());
}

function parseTodoBacklog(input: any): TodoSnapshot['backlog'] {
  if (!Array.isArray(input?.backlog)) return [];
  return input.backlog
    .map((item: any) => ({
      type: stringField(item?.type) || undefined,
      title: stringField(item?.title) || '',
      priority: stringField(item?.priority) || undefined,
      reason: stringField(item?.reason) || undefined,
    }))
    .filter((item: { title: string }) => item.title.length > 0);
}

function parseTodoQuestions(input: any): TodoSnapshot['questions'] {
  if (!Array.isArray(input?.questions)) return [];
  return input.questions
    .map((item: any) => ({
      title: stringField(item?.title) || '',
      status: stringField(item?.status) || undefined,
      reason: stringField(item?.reason) || undefined,
    }))
    .filter((item: { title: string }) => item.title.length > 0);
}

function parseWorkstreamIdentity(work: any, row: Omit<TodoSnapshot, 'workstreamKey' | 'workstreamTitle' | 'runTitle' | 'outcome' | 'todos' | 'backlog' | 'questions'>): Pick<TodoSnapshot, 'workstreamKey' | 'workstreamTitle' | 'runTitle' | 'outcome'> {
  const v3Key = stringField(work?.workstreamKey);
  const v3Title = stringField(work?.workstreamTitle);
  const v3RunTitle = stringField(work?.runTitle);
  const v3Outcome = stringField(work?.outcome);

  const legacyEpic = stringField(work?.epic);
  const legacyTitle = stringField(work?.title);
  const legacyGoal = stringField(work?.goal);

  const keySource = v3Key || legacyEpic || v3Title || legacyTitle || row.sessionName || 'untitled-workstream';
  const titleSource = v3Title || (v3Key ? humanizeKey(v3Key) : null) || (legacyEpic ? humanizeKey(legacyEpic) : null) || legacyTitle || row.sessionName || 'Untitled workstream';

  return {
    workstreamKey: keySource,
    workstreamTitle: titleSource,
    runTitle: v3RunTitle || legacyTitle,
    outcome: v3Outcome || legacyGoal,
  };
}

function parseTodoSnapshots(content: string, row: Omit<TodoSnapshot, 'workstreamKey' | 'workstreamTitle' | 'runTitle' | 'outcome' | 'todos' | 'backlog' | 'questions' | 'runStatus' | 'source'>): TodoSnapshot[] {
  let blocks: any[];
  try {
    const parsed = JSON.parse(content);
    blocks = Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }

  const snapshots: TodoSnapshot[] = [];
  for (const block of blocks) {
    if (block?.type !== 'tool_use' || block?.name !== 'TodoWrite') continue;
    const input = block.input || {};
    const todos: TodoSnapshot['todos'] = Array.isArray(input.todos)
      ? input.todos
        .map((todo: any) => ({
          content: String(todo?.content || todo?.title || '').trim(),
          status: String(todo?.status || 'pending'),
        }))
        .filter((todo: { content: string }) => todo.content.length > 0)
      : [];
    if (todos.length === 0) continue;

    const work = input.work && typeof input.work === 'object' ? input.work : {};
    const identity = parseWorkstreamIdentity(work, row);
    snapshots.push({
      ...row,
      ...identity,
      todos,
      backlog: parseTodoBacklog(input),
      questions: parseTodoQuestions(input),
      runStatus: todos.some((todo) => todo.status === 'in_progress') ? 'running' : todos.every((todo) => todo.status === 'completed') ? 'completed' : 'running',
      source: 'todowrite',
    });
  }
  return snapshots;
}

function statusRank(status: string): number {
  if (status === 'completed') return 3;
  if (status === 'in_progress') return 2;
  return 1;
}

function safeId(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9가-힣_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'challenge';
}

function ledgerStatusToSnapshotStatus(status: WorkLedgerRecord['status']): TodoSnapshot['runStatus'] {
  if (status === 'completed' || status === 'cancelled' || status === 'failed' || status === 'blocked' || status === 'running') return status;
  return 'running';
}

function workLedgerToSnapshot(record: WorkLedgerRecord & { projectName?: string; ownerName?: string; agentName?: string; agentFace?: string | null }): TodoSnapshot {
  const title = record.workstreamTitle || humanizeKey(record.workstreamKey) || record.workstreamKey;
  return {
    sessionId: record.sessionId || `work-ledger:${record.runId}`,
    sessionName: record.runTitle,
    projectId: record.projectId,
    projectName: record.projectName || 'No project',
    ownerUserId: record.ownerUserId,
    ownerName: record.ownerName || 'unknown',
    agentName: record.agentName || record.projectName || 'AI 팀원',
    agentFace: record.agentFace || null,
    at: new Date(record.activityAt),
    workstreamKey: record.workstreamKey,
    workstreamTitle: title,
    runTitle: record.runTitle,
    outcome: record.outcome,
    todos: record.todos || [],
    backlog: record.backlog || [],
    questions: record.questions || [],
    runStatus: ledgerStatusToSnapshotStatus(record.status),
    source: 'work_ledger',
  };
}

function mergeByTitle<T extends { title: string }>(items: T[]): T[] {
  const byTitle = new Map<string, T>();
  for (const item of items) if (item.title) byTitle.set(item.title, item);
  return Array.from(byTitle.values());
}

function mergeTodoLists(items: Array<{ content: string; status: string }>): Array<{ content: string; status: string }> {
  const byContent = new Map<string, { content: string; status: string }>();
  for (const item of items) {
    const existing = byContent.get(item.content);
    if (!existing || statusRank(item.status) >= statusRank(existing.status)) byContent.set(item.content, item);
  }
  return Array.from(byContent.values());
}

function mergeRunStatus(a?: TodoSnapshot['runStatus'], b?: TodoSnapshot['runStatus']): TodoSnapshot['runStatus'] {
  const rank = (status?: TodoSnapshot['runStatus']) => {
    if (status === 'failed') return 5;
    if (status === 'blocked') return 4;
    if (status === 'running') return 3;
    if (status === 'completed') return 2;
    if (status === 'cancelled') return 1;
    return 0;
  };
  return rank(b) > rank(a) ? b : a;
}

function dedupeLedgerTodoSnapshots(snapshots: TodoSnapshot[]): TodoSnapshot[] {
  const out: TodoSnapshot[] = [];
  const crossSourceByRun = new Map<string, number>();
  for (const snapshot of snapshots) {
    const key = snapshot.runTitle
      ? `${snapshot.projectId || 'none'}::${snapshot.workstreamKey}::${snapshot.sessionId}::${snapshot.runTitle}`
      : null;
    const existingIndex = key ? crossSourceByRun.get(key) : undefined;
    if (existingIndex === undefined) {
      if (key) crossSourceByRun.set(key, out.length);
      out.push(snapshot);
      continue;
    }

    const existing = out[existingIndex];
    // Only collapse cross-source duplicates. Multiple TodoWrite snapshots for the
    // same run remain useful progress history until a canonical run id exists.
    if (existing.source === snapshot.source) {
      out.push(snapshot);
      continue;
    }

    out[existingIndex] = {
      ...existing,
      sessionName: existing.source === 'work_ledger' ? existing.sessionName : snapshot.sessionName,
      at: existing.at > snapshot.at ? existing.at : snapshot.at,
      outcome: existing.outcome || snapshot.outcome,
      todos: mergeTodoLists([...existing.todos, ...snapshot.todos]),
      backlog: mergeByTitle([...existing.backlog, ...snapshot.backlog]),
      questions: mergeByTitle([...existing.questions, ...snapshot.questions]),
      runStatus: mergeRunStatus(existing.runStatus, snapshot.runStatus),
      source: 'work_ledger',
    };
  }
  return out;
}

/**
 * Build Project → Challenge timeline rows from persisted TodoWrite snapshots.
 * Respects role/session visibility; it never reads live runtime state.
 */
export async function getChallengeTimeline(params: ChallengeTimelineParams): Promise<ChallengeTimelineResult> {
  const rangeHours = clampInt(params.rangeHours, 24, 1, 24 * 15);
  const bucketHours = clampInt(params.bucketHours, 2, 1, 24);
  const limitChallenges = clampInt(params.limitChallenges, 80, 1, 300);
  const end = ceilToBucket(new Date(), bucketHours);
  const start = new Date(end.getTime() - rangeHours * 60 * 60 * 1000);

  const conditions: string[] = [
    "m.content LIKE '%TodoWrite%'",
    "m.role = 'assistant'",
    '(s.archived IS NULL OR s.archived = 0)',
    '(p.archived IS NULL OR p.archived = 0)',
    'm.created_at >= $1',
    'm.created_at <= $2',
  ];
  const values: any[] = [start.toISOString(), end.toISOString()];
  const isPrivileged = params.role === 'admin' || params.role === 'operator';
  const accessibleProjectIds = !isPrivileged ? (await getAccessibleProjectIds(params.userId, params.role)) || [] : null;
  // My Work is personal delegation history, not a project-wide activity feed.
  const requestedOwnerUserId = params.ownerUserId && Number.isFinite(params.ownerUserId)
    ? params.ownerUserId
    : params.userId;

  const ledgerRecords = await listWorkLedgerRecords({
    start,
    end,
    projectId: params.projectId,
    ownerUserId: requestedOwnerUserId,
    accessibleProjectIds,
    requesterUserId: params.userId,
    privileged: isPrivileged,
    limit: Math.min(limitChallenges * 40, 5000),
  });

  if (params.projectId && params.projectId !== 'all') {
    values.push(params.projectId);
    conditions.push(`s.project_id = $${values.length}`);
  }
  values.push(requestedOwnerUserId);
  conditions.push(`s.user_id = $${values.length}`);

  if (!isPrivileged) {
    values.push(params.userId);
    const ownParam = values.length;
    values.push(accessibleProjectIds || []);
    const projectsParam = values.length;
    conditions.push(`(
      s.user_id = $${ownParam}
      OR (s.project_id = ANY($${projectsParam}::text[]) AND (s.user_id IS NULL OR s.visibility = 'project'))
    )`);
  }

  values.push(Math.min(limitChallenges * 40, 5000));
  const rows = await query<{
    session_id: string;
    session_name: string;
    project_id: string | null;
    project_name: string | null;
    owner_user_id: number | null;
    owner_name: string | null;
    agent_name: string | null;
    agent_face: string | null;
    created_at: Date;
    content: string;
  }>(`
    SELECT
      m.session_id,
      s.name AS session_name,
      s.project_id,
      COALESCE(p.name, 'No project') AS project_name,
      s.user_id AS owner_user_id,
      COALESCE(u.display_name, u.username, 'unknown') AS owner_name,
      COALESCE(s.project_agent_profile_snapshot->>'displayName', pap.display_name, p.name, 'AI 팀원') AS agent_name,
      COALESCE(s.project_agent_profile_snapshot->>'face', pap.face) AS agent_face,
      m.created_at,
      m.content
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    LEFT JOIN projects p ON p.id = s.project_id
    LEFT JOIN project_agent_profiles pap ON pap.project_id = s.project_id
    LEFT JOIN users u ON u.id = s.user_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY m.created_at DESC
    LIMIT $${values.length}
  `, values);

  const snapshots: TodoSnapshot[] = dedupeLedgerTodoSnapshots([
    ...ledgerRecords.map((record) => workLedgerToSnapshot(record as WorkLedgerRecord & { projectName?: string; ownerName?: string; agentName?: string; agentFace?: string | null })),
    ...rows.flatMap((row) => parseTodoSnapshots(row.content, {
      sessionId: row.session_id,
      sessionName: row.session_name || 'Untitled session',
      projectId: row.project_id,
      projectName: row.project_name || 'No project',
      ownerUserId: row.owner_user_id,
      ownerName: row.owner_name || 'unknown',
      agentName: row.agent_name || row.project_name || 'AI 팀원',
      agentFace: row.agent_face || null,
      at: new Date(row.created_at),
    })),
  ]);

  type ChallengeBucket = {
    projectId: string | null;
    projectName: string;
    workstreamKey: string;
    workstreamTitle: string;
    owners: Set<string>;
    sessions: Map<string, {
      id: string;
      name: string;
      owner: string;
      agentName: string;
      agentFace: string | null;
      projectId: string | null;
      projectName: string;
      snapshots: TodoSnapshot[];
      todos: Map<string, { content: string; status: string }>;
      runTitles: Set<string>;
      lastAt: Date;
    }>;
    snapshots: TodoSnapshot[];
    todos: Map<string, { content: string; status: string }>;
    runTitles: Set<string>;
    outcomes: Set<string>;
    backlog: Map<string, ChallengeTimelineFollowUpItem>;
    questions: Map<string, ChallengeTimelineQuestion>;
    lastAt: Date;
  };

  const challengeMap = new Map<string, ChallengeBucket>();
  for (const snapshot of snapshots) {
    const key = `${snapshot.projectId || 'none'}::${snapshot.workstreamKey}`;
    if (!challengeMap.has(key)) {
      challengeMap.set(key, {
        projectId: snapshot.projectId,
        projectName: snapshot.projectName,
        workstreamKey: snapshot.workstreamKey,
        workstreamTitle: snapshot.workstreamTitle,
        owners: new Set(),
        sessions: new Map(),
        snapshots: [],
        todos: new Map(),
        runTitles: new Set(),
        outcomes: new Set(),
        backlog: new Map(),
        questions: new Map(),
        lastAt: snapshot.at,
      });
    }
    const challenge = challengeMap.get(key)!;
    challenge.owners.add(snapshot.ownerName);
    if (!challenge.sessions.has(snapshot.sessionId)) {
      challenge.sessions.set(snapshot.sessionId, {
        id: snapshot.sessionId,
        name: snapshot.sessionName,
        owner: snapshot.ownerName,
        agentName: snapshot.agentName,
        agentFace: snapshot.agentFace,
        projectId: snapshot.projectId,
        projectName: snapshot.projectName,
        snapshots: [],
        todos: new Map(),
        runTitles: new Set(),
        lastAt: snapshot.at,
      });
    }
    const session = challenge.sessions.get(snapshot.sessionId)!;
    session.snapshots.push(snapshot);
    if (snapshot.at > session.lastAt) session.lastAt = snapshot.at;
    if (snapshot.runTitle) session.runTitles.add(snapshot.runTitle);
    for (const todo of snapshot.todos) {
      const existing = session.todos.get(todo.content);
      if (!existing || statusRank(todo.status) >= statusRank(existing.status)) {
        session.todos.set(todo.content, todo);
      }
    }
    challenge.snapshots.push(snapshot);
    if (snapshot.runTitle) challenge.runTitles.add(snapshot.runTitle);
    if (snapshot.outcome) challenge.outcomes.add(snapshot.outcome);
    if (snapshot.at > challenge.lastAt) challenge.lastAt = snapshot.at;
    for (const todo of snapshot.todos) {
      const existing = challenge.todos.get(todo.content);
      if (!existing || statusRank(todo.status) >= statusRank(existing.status)) {
        challenge.todos.set(todo.content, todo);
      }
    }
    for (const item of snapshot.backlog) {
      challenge.backlog.set(item.title, item);
    }
    for (const question of snapshot.questions) {
      challenge.questions.set(question.title, question);
    }
  }

  const spanGapMs = Math.max(45 * 60_000, bucketHours * 60 * 60_000 * 0.75);
  const minSegmentMs = Math.min(30 * 60_000, bucketHours * 60 * 60_000 * 0.25);

  const challengeRows: ChallengeTimelineRow[] = Array.from(challengeMap.values()).map((challenge) => {
    const ordered = [...challenge.snapshots].sort((a, b) => a.at.getTime() - b.at.getTime());
    const todoList = Array.from(challenge.todos.values());
    const todoDone = todoList.filter((todo) => todo.status === 'completed').length;
    const todoLeft = todoList.length - todoDone;
    const hasFreshRunningLedger = challenge.snapshots.some((snapshot) => snapshot.source === 'work_ledger' && snapshot.runStatus === 'running' && isFreshActivity(snapshot.at, end));
    const hasStaleRunningLedger = challenge.snapshots.some((snapshot) => snapshot.source === 'work_ledger' && snapshot.runStatus === 'running' && !isFreshActivity(snapshot.at, end));
    const hasFreshInProgressTodo = challenge.snapshots.some((snapshot) => isFreshActivity(snapshot.at, end) && snapshot.todos.some((todo) => todo.status === 'in_progress'));
    const hasFailedLedger = challenge.snapshots.some((snapshot) => snapshot.source === 'work_ledger' && snapshot.runStatus === 'failed');
    const hasBlockedLedger = challenge.snapshots.some((snapshot) => snapshot.source === 'work_ledger' && snapshot.runStatus === 'blocked');
    const status: ChallengeTimelineRow['status'] = hasFailedLedger || hasBlockedLedger
      ? 'waiting'
      : hasFreshRunningLedger || hasFreshInProgressTodo
        ? 'active'
        : hasStaleRunningLedger ? 'waiting'
          : todoLeft === 0 ? 'resolved' : 'waiting';
    const waitingReason: ChallengeTimelineWaitingReason = status !== 'waiting'
      ? null
      : hasFailedLedger ? 'failed'
        : hasBlockedLedger ? 'blocked'
          : hasStaleRunningLedger ? 'stale' : 'unfinished';

    const segments: Array<{ start: Date; end: Date; snapshotCount: number; hasDone: boolean; hasActive: boolean }> = [];
    let current: { start: Date; end: Date; snapshotCount: number; hasDone: boolean; hasActive: boolean } | null = null;
    for (const snapshot of ordered) {
      const snapshotEnd = new Date(snapshot.at.getTime() + minSegmentMs);
      const hasDone = snapshot.runStatus === 'completed' || snapshot.todos.some((todo) => todo.status === 'completed');
      const hasActive = snapshot.runStatus === 'running' || snapshot.todos.some((todo) => todo.status === 'in_progress');
      if (!current || snapshot.at.getTime() - current.end.getTime() > spanGapMs) {
        if (current) segments.push(current);
        current = { start: snapshot.at, end: snapshotEnd, snapshotCount: 1, hasDone, hasActive };
      } else {
        current.end = new Date(Math.max(current.end.getTime(), snapshotEnd.getTime()));
        current.snapshotCount += 1;
        current.hasDone = current.hasDone || hasDone;
        current.hasActive = current.hasActive || hasActive;
      }
    }
    if (current) segments.push(current);

    return {
      id: `${challenge.projectId || 'none'}:${safeId(challenge.workstreamKey)}`,
      title: challenge.workstreamTitle,
      workstreamKey: challenge.workstreamKey,
      runTitles: Array.from(challenge.runTitles).slice(-10),
      outcomes: Array.from(challenge.outcomes).slice(-10),
      projectId: challenge.projectId,
      projectName: challenge.projectName,
      owners: Array.from(challenge.owners).slice(0, 5),
      sessionCount: challenge.sessions.size,
      todoTotal: todoList.length,
      todoDone,
      todoLeft,
      backlog: Array.from(challenge.backlog.values()).slice(-20),
      questions: Array.from(challenge.questions.values()).slice(-20),
      sessions: Array.from(challenge.sessions.values())
        .sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime())
        .slice(0, 20)
        .map((session) => {
          const sessionTodos = Array.from(session.todos.values());
          const sessionTodoDone = sessionTodos.filter((todo) => todo.status === 'completed').length;
          return {
            id: session.id,
            name: session.name,
            owner: session.owner,
            agentName: session.agentName,
            agentFace: session.agentFace,
            projectId: session.projectId,
            projectName: session.projectName,
            lastAt: session.lastAt.toISOString(),
            snapshotCount: session.snapshots.length,
            todoTotal: sessionTodos.length,
            todoDone: sessionTodoDone,
            todoLeft: sessionTodos.length - sessionTodoDone,
            runTitles: Array.from(session.runTitles).slice(-5),
            openTodos: sessionTodos.filter((todo) => todo.status !== 'completed').slice(0, 8),
            completedTodos: sessionTodos.filter((todo) => todo.status === 'completed').slice(-5),
          };
        }),
      status,
      waitingReason,
      lastAt: challenge.lastAt.toISOString(),
      segments: segments.map((segment) => {
        const kind: ChallengeTimelineSegment['kind'] = status === 'resolved' || (segment.hasDone && !segment.hasActive)
          ? 'done'
          : segment.hasActive ? 'active' : 'work';
        return {
          start: segment.start.toISOString(),
          end: segment.end.toISOString(),
          kind,
          snapshotCount: segment.snapshotCount,
        };
      }),
    };
  }).sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime()).slice(0, limitChallenges);

  const projectsByKey = new Map<string, ChallengeTimelineProject>();
  for (const challenge of challengeRows) {
    const key = challenge.projectId || 'none';
    if (!projectsByKey.has(key)) {
      projectsByKey.set(key, {
        id: challenge.projectId,
        name: challenge.projectName,
        challengeCount: 0,
        todoLeft: 0,
        challenges: [],
      });
    }
    const project = projectsByKey.get(key)!;
    project.challenges.push(challenge);
    project.challengeCount += 1;
    project.todoLeft += challenge.todoLeft;
  }

  const ticks: string[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += bucketHours * 60 * 60_000) {
    ticks.push(new Date(t).toISOString());
  }

  const projects = Array.from(projectsByKey.values()).sort((a, b) => {
    const aLast = Math.max(...a.challenges.map((c) => new Date(c.lastAt).getTime()));
    const bLast = Math.max(...b.challenges.map((c) => new Date(c.lastAt).getTime()));
    return bLast - aLast;
  });

  return {
    rangeHours,
    bucketHours,
    start: start.toISOString(),
    end: end.toISOString(),
    ticks,
    projects,
    totals: {
      projects: projects.length,
      challenges: challengeRows.length,
      todoLeft: challengeRows.reduce((sum, challenge) => sum + challenge.todoLeft, 0),
      snapshots: snapshots.length,
    },
  };
}
