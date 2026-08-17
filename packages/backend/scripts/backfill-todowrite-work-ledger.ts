/**
 * Backfill canonical Work Ledger rows from persisted TodoWrite tool_use messages.
 * Dry-run by default. Pass --apply only after reviewing the summary.
 */
import { createHash } from 'node:crypto';
import { query } from '../db/pg-repo.js';
import { upsertWorkLedgerRecord } from '../services/work/work-ledger.js';

type Candidate = {
  sessionId: string;
  projectId: string | null;
  ownerUserId: number | null;
  messageId: string;
  at: Date;
  toolCallId: string;
  work: any;
  todos: Array<{ status?: string }>;
  backlog?: any[];
  questions?: any[];
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function identity(candidate: Candidate): { workstreamKey: string; workstreamTitle?: string; runTitle: string } | null {
  const key = text(candidate.work?.workstreamKey) || text(candidate.work?.epic);
  const runTitle = text(candidate.work?.runTitle) || text(candidate.work?.title);
  if (!key || !runTitle) return null;
  return { workstreamKey: key, workstreamTitle: text(candidate.work?.workstreamTitle) || text(candidate.work?.epic) || undefined, runTitle };
}

function stableId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export async function collectTodoWriteBackfillCandidates(days: number): Promise<Candidate[]> {
  const rows = await query<any>(`
    SELECT m.id AS message_id, m.session_id, m.created_at, m.content,
           s.project_id, s.user_id AS owner_user_id
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE m.role = 'assistant'
      AND m.content LIKE '%TodoWrite%'
      AND m.created_at >= NOW() - ($1::text || ' days')::interval
    ORDER BY m.created_at ASC
  `, [days]);

  const candidates: Candidate[] = [];
  for (const row of rows) {
    let blocks: any[] = [];
    try {
      const parsed = JSON.parse(row.content);
      blocks = Array.isArray(parsed) ? parsed : [];
    } catch {
      continue;
    }
    for (const block of blocks) {
      if (block?.type !== 'tool_use' || block?.name !== 'TodoWrite') continue;
      const input = block.input || {};
      if (!input.work || !Array.isArray(input.todos) || input.todos.length === 0) continue;
      candidates.push({
        sessionId: row.session_id,
        projectId: row.project_id,
        ownerUserId: row.owner_user_id,
        messageId: row.message_id,
        at: new Date(row.created_at),
        toolCallId: text(block.id) || row.message_id,
        work: input.work,
        todos: input.todos,
        backlog: input.backlog,
        questions: input.questions,
      });
    }
  }
  return candidates;
}

export function collapseTodoWriteBackfillCandidates(candidates: Candidate[]): Candidate[] {
  const latest = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const id = identity(candidate);
    if (!id) continue;
    const key = `${candidate.sessionId}\u0000${id.workstreamKey}\u0000${id.runTitle}`;
    const previous = latest.get(key);
    if (!previous || previous.at <= candidate.at) latest.set(key, candidate);
  }
  return Array.from(latest.values()).sort((a, b) => a.at.getTime() - b.at.getTime());
}

export async function backfillTodoWriteWorkLedger(args: { days: number; apply: boolean }) {
  const snapshots = await collectTodoWriteBackfillCandidates(args.days);
  const runs = collapseTodoWriteBackfillCandidates(snapshots);
  let completed = 0;
  let running = 0;
  for (const candidate of runs) {
    const id = identity(candidate)!;
    const status = candidate.todos.every((todo) => todo.status === 'completed') ? 'completed' : 'running';
    if (status === 'completed') completed += 1;
    else running += 1;
    if (!args.apply) continue;

    const sourceId = `backfill:${stableId(`${candidate.sessionId}:${id.workstreamKey}:${id.runTitle}`)}`;
    await upsertWorkLedgerRecord({
      runId: sourceId,
      projectId: candidate.projectId,
      sessionId: candidate.sessionId,
      ownerUserId: candidate.ownerUserId,
      workstreamKey: id.workstreamKey,
      workstreamTitle: id.workstreamTitle,
      runTitle: id.runTitle,
      outcome: text(candidate.work?.outcome) || text(candidate.work?.goal),
      note: text(candidate.work?.note) || text(candidate.work?.description),
      sourceType: 'todowrite',
      sourceId,
      sourceRefs: { backfilled: true, latestMessageId: candidate.messageId, latestTodoWriteToolCallId: candidate.toolCallId },
      status,
      todos: candidate.todos.map((todo: any) => ({
        content: text(todo?.content) || text(todo?.title) || '',
        status: text(todo?.status) || 'pending',
        activeForm: text(todo?.activeForm) || undefined,
      })).filter((todo) => todo.content.length > 0),
      backlog: candidate.backlog,
      questions: candidate.questions,
      activityAt: candidate.at.toISOString(),
      startedAt: candidate.at.toISOString(),
      completedAt: status === 'completed' ? candidate.at.toISOString() : null,
    });
  }
  return { mode: args.apply ? 'apply' : 'dry-run', days: args.days, snapshots: snapshots.length, runs: runs.length, completed, running };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const apply = process.argv.includes('--apply');
  const daysArg = process.argv.find((arg) => arg.startsWith('--days='));
  const days = Math.min(Math.max(Number(daysArg?.split('=')[1] || 15), 1), 365);
  backfillTodoWriteWorkLedger({ days, apply })
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
