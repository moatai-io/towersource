// Owns: Approval Card persistence, ACL-filtered projections, revision history, and state transitions.
// Public API: create/list/get/resolve/resubmit Approval Cards. See README.md.

import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { query, queryOne, transaction, withClient } from '../../db/pg-repo.js';
import { canAccessSession, isPathAccessible, isPrivilegedRole } from '../pm/project-access.js';
import { isProjectMember } from '../pm/project-membership-manager.js';

export type ApprovalStatus = 'pending' | 'approved' | 'changes_requested' | 'rejected' | 'cancelled' | 'stale';
export type ApprovalResolution = 'approved' | 'changes_requested' | 'rejected';
export type ApprovalAttachmentInput = {
  type: 'markdown' | 'file' | 'link' | 'session' | 'run';
  label?: string;
  markdown?: string;
  path?: string;
  url?: string;
  sessionId?: string;
  runId?: string;
};

export class ApprovalCardError extends Error {
  constructor(public code: 'INVALID' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'STALE', message: string) {
    super(message);
  }
}

interface CardRow {
  id: string; project_id: string; submitter_type: 'user' | 'workspace_agent'; submitter_user_id: number; approver_user_id: number;
  source_session_id: string | null; source_agent_run_id: string | null; source_automation_run_id: string | null;
  request_type: string; title: string; status: ApprovalStatus; current_revision_no: number;
  resolved_by_user_id: number | null; resolved_at: string | null; due_at: string | null;
  created_at: string; updated_at: string;
}
interface RevisionRow {
  id: string; card_id: string; revision_no: number; summary_md: string;
  recommendation_md: string | null; consequence_md: string; options: any;
  submitted_by_user_id: number; created_at: string;
}
interface AttachmentRow {
  id: string; card_id: string; revision_no: number; attachment_type: ApprovalAttachmentInput['type'];
  label: string | null; payload: any; content_hash: string | null; created_at: string;
}
interface EventRow { id: string; card_id: string; actor_user_id: number | null; event_type: string; payload: any; created_at: string }

function cleanText(value: unknown, max: number, required = false): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new ApprovalCardError('INVALID', 'required text is missing');
  if (text.length > max) throw new ApprovalCardError('INVALID', `text exceeds ${max} characters`);
  return text;
}

async function userExists(userId: number): Promise<boolean> {
  return !!await queryOne('SELECT 1 FROM users WHERE id = $1 AND disabled = 0', [userId]);
}

async function canUseProject(projectId: string, userId: number, role: string): Promise<boolean> {
  if (isPrivilegedRole(role)) return !!await queryOne('SELECT 1 FROM projects WHERE id = $1', [projectId]);
  return await isProjectMember(projectId, userId)
    || !!await queryOne('SELECT 1 FROM projects WHERE id = $1 AND user_id = $2', [projectId, userId]);
}

async function assertProjectAccess(projectId: string, userId: number, role: string): Promise<void> {
  if (!projectId || !await canUseProject(projectId, userId, role)) throw new ApprovalCardError('FORBIDDEN', 'Agent Workspace access denied');
}

async function assertApproverAccess(projectId: string, approverUserId: number): Promise<void> {
  if (!await userExists(approverUserId)) throw new ApprovalCardError('INVALID', 'approver does not exist or is disabled');
  const role = (await queryOne<{ role: string }>('SELECT role FROM users WHERE id = $1', [approverUserId]))?.role || 'member';
  if (!await canUseProject(projectId, approverUserId, role)) throw new ApprovalCardError('FORBIDDEN', 'approver cannot access this Agent Workspace');
}

async function sha256File(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

async function normalizeAttachment(input: ApprovalAttachmentInput, ctx: { userId: number; role: string; projectId: string }) {
  const label = cleanText(input.label, 200);
  if (input.type === 'markdown') {
    const markdown = cleanText(input.markdown, 100_000, true);
    return { type: input.type, label: label || '본문', payload: { markdown }, contentHash: createHash('sha256').update(markdown).digest('hex') };
  }
  if (input.type === 'link') {
    const url = cleanText(input.url, 4000, true);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new ApprovalCardError('INVALID', 'invalid link URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new ApprovalCardError('INVALID', 'only http/https links are allowed');
    return { type: input.type, label: label || parsed.hostname, payload: { url }, contentHash: null };
  }
  if (input.type === 'file') {
    const filePath = path.resolve(cleanText(input.path, 4000, true));
    if (!await isPathAccessible(filePath, ctx.userId, ctx.role)) throw new ApprovalCardError('FORBIDDEN', 'file attachment is not accessible');
    const st = await fs.stat(filePath).catch(() => null);
    if (!st?.isFile()) throw new ApprovalCardError('INVALID', 'file attachment does not exist');
    const projectRoot = (await queryOne<{ root_path: string }>('SELECT root_path FROM projects WHERE id = $1', [ctx.projectId]))?.root_path;
    if (!projectRoot || !(filePath === path.resolve(projectRoot) || filePath.startsWith(path.resolve(projectRoot) + path.sep))) {
      throw new ApprovalCardError('FORBIDDEN', 'file attachment must be inside the Agent Workspace');
    }
    return { type: input.type, label: label || path.basename(filePath), payload: { path: filePath }, contentHash: await sha256File(filePath) };
  }
  if (input.type === 'session') {
    const sessionId = cleanText(input.sessionId, 200, true);
    const access = await canAccessSession(sessionId, ctx.userId, ctx.role);
    if (!access.allowed) throw new ApprovalCardError('FORBIDDEN', access.message);
    const row = await queryOne<{ project_id: string | null }>('SELECT project_id FROM sessions WHERE id = $1', [sessionId]);
    if (row?.project_id !== ctx.projectId) throw new ApprovalCardError('FORBIDDEN', 'session attachment belongs to another Agent Workspace');
    return { type: input.type, label: label || '관련 Session', payload: { sessionId }, contentHash: null };
  }
  const runId = cleanText(input.runId, 200, true);
  const run = await queryOne<{ automation_id: string; project_id: string | null }>(`
    SELECT ar.automation_id, a.project_id
    FROM automation_runs ar JOIN automations a ON a.id = ar.automation_id
    WHERE ar.id = $1
  `, [runId]);
  if (!run || run.project_id !== ctx.projectId) throw new ApprovalCardError('FORBIDDEN', 'run attachment is not in this Agent Workspace');
  return { type: input.type, label: label || '실행 기록', payload: { runId }, contentHash: null };
}

function mapCard(row: CardRow, revision?: RevisionRow, attachments: AttachmentRow[] = [], events: EventRow[] = []) {
  return {
    id: row.id,
    projectId: row.project_id,
    submitterType: row.submitter_type || 'user',
    submitterUserId: row.submitter_user_id,
    approverUserId: row.approver_user_id,
    sourceSessionId: row.source_session_id,
    sourceAgentRunId: row.source_agent_run_id,
    sourceAutomationRunId: row.source_automation_run_id,
    requestType: row.request_type,
    title: row.title,
    status: row.status,
    currentRevisionNo: row.current_revision_no,
    resolvedByUserId: row.resolved_by_user_id,
    resolvedAt: row.resolved_at,
    dueAt: row.due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: revision ? {
      revisionNo: revision.revision_no,
      summaryMd: revision.summary_md,
      recommendationMd: revision.recommendation_md,
      consequenceMd: revision.consequence_md,
      options: revision.options || [],
      submittedByUserId: revision.submitted_by_user_id,
      createdAt: revision.created_at,
    } : null,
    attachments: attachments.map((a) => ({
      id: a.id, revisionNo: a.revision_no, type: a.attachment_type, label: a.label,
      payload: a.payload || {}, contentHash: a.content_hash, createdAt: a.created_at,
    })),
    events: events.map((e) => ({ id: e.id, actorUserId: e.actor_user_id, type: e.event_type, payload: e.payload || {}, createdAt: e.created_at })),
  };
}

async function assertCardVisible(row: CardRow, userId: number, role: string): Promise<void> {
  if (isPrivilegedRole(role) || row.submitter_user_id === userId || row.approver_user_id === userId) return;
  throw new ApprovalCardError('FORBIDDEN', 'approval card access denied');
}

/** Create a DB-canonical card with immutable revision 1 and append-only submitted event. */
export async function createApprovalCard(input: {
  userId: number; role: string; projectId: string; approverUserId: number; requestType?: string; submitterType?: 'user' | 'workspace_agent';
  title: string; summaryMd: string; recommendationMd?: string; consequenceMd: string;
  options?: Array<{ id: string; label: string }>; attachments?: ApprovalAttachmentInput[];
  sourceSessionId?: string; sourceAgentRunId?: string; sourceAutomationRunId?: string; dueAt?: string;
}) {
  await assertProjectAccess(input.projectId, input.userId, input.role);
  await assertApproverAccess(input.projectId, input.approverUserId);
  if (input.sourceSessionId) {
    const access = await canAccessSession(input.sourceSessionId, input.userId, input.role);
    if (!access.allowed) throw new ApprovalCardError('FORBIDDEN', access.message);
    const session = await queryOne<{ project_id: string | null }>('SELECT project_id FROM sessions WHERE id = $1', [input.sourceSessionId]);
    if (session?.project_id !== input.projectId) throw new ApprovalCardError('FORBIDDEN', 'source Session belongs to another Agent Workspace');
  }
  const requestType = input.requestType || 'artifact_review';
  const allowedTypes = ['artifact_review', 'decision', 'action_authorization', 'publication', 'policy_change', 'access_change'];
  if (!allowedTypes.includes(requestType)) throw new ApprovalCardError('INVALID', 'invalid request type');
  const title = cleanText(input.title, 300, true);
  const summaryMd = cleanText(input.summaryMd, 100_000, true);
  const recommendationMd = cleanText(input.recommendationMd, 50_000);
  const consequenceMd = cleanText(input.consequenceMd, 50_000, true);
  const options = Array.isArray(input.options) ? input.options.slice(0, 12).map((o) => ({ id: cleanText(o?.id, 80, true), label: cleanText(o?.label, 160, true) })) : [];
  const attachments: Awaited<ReturnType<typeof normalizeAttachment>>[] = [];
  for (const item of input.attachments || []) attachments.push(await normalizeAttachment(item, { userId: input.userId, role: input.role, projectId: input.projectId }));

  const cardId = await transaction(async (client) => {
    const db = withClient(client);
    const card = await db.queryOne<{ id: string }>(`
      INSERT INTO approval_cards (
        project_id, submitter_type, submitter_user_id, approver_user_id, source_session_id, source_agent_run_id,
        source_automation_run_id, request_type, title, due_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id
    `, [input.projectId, input.submitterType || 'user', input.userId, input.approverUserId, input.sourceSessionId || null, input.sourceAgentRunId || null, input.sourceAutomationRunId || null, requestType, title, input.dueAt || null]);
    if (!card) throw new ApprovalCardError('INVALID', 'failed to create approval card');
    await db.execute(`INSERT INTO approval_card_revisions (card_id, revision_no, summary_md, recommendation_md, consequence_md, options, submitted_by_user_id) VALUES ($1,1,$2,$3,$4,$5::jsonb,$6)`, [card.id, summaryMd, recommendationMd || null, consequenceMd, JSON.stringify(options), input.userId]);
    for (const item of attachments) await db.execute(`INSERT INTO approval_card_attachments (card_id, revision_no, attachment_type, label, payload, content_hash) VALUES ($1,1,$2,$3,$4::jsonb,$5)`, [card.id, item.type, item.label || null, JSON.stringify(item.payload), item.contentHash]);
    await db.execute(`INSERT INTO approval_card_events (card_id, actor_user_id, event_type, payload) VALUES ($1,$2,'submitted',$3::jsonb)`, [card.id, input.userId, JSON.stringify({ revisionNo: 1 })]);
    return card.id;
  });
  return await getApprovalCard(cardId, input.userId, input.role);
}

/** List cards visible to the current user for My Work projections. */
export async function listApprovalCards(params: { userId: number; role: string; box?: 'assigned' | 'sent' | 'all'; status?: ApprovalStatus; projectId?: string; limit?: number }) {
  const where: string[] = [];
  const args: any[] = [];
  if (!isPrivilegedRole(params.role) || params.box === 'assigned' || params.box === 'sent') {
    const col = params.box === 'sent' ? 'submitter_user_id' : params.box === 'assigned' ? 'approver_user_id' : null;
    if (col) { args.push(params.userId); where.push(`${col} = $${args.length}`); }
    else { args.push(params.userId); where.push(`(submitter_user_id = $${args.length} OR approver_user_id = $${args.length})`); }
  }
  if (params.status) { args.push(params.status); where.push(`status = $${args.length}`); }
  if (params.projectId) { await assertProjectAccess(params.projectId, params.userId, params.role); args.push(params.projectId); where.push(`project_id = $${args.length}`); }
  args.push(Math.min(Math.max(params.limit || 100, 1), 300));
  const rows = await query<CardRow>(`SELECT * FROM approval_cards ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT $${args.length}`, args);
  return rows.map((row) => mapCard(row));
}

/** Read one card and its current revision, attachments, and event history. */
export async function getApprovalCard(id: string, userId: number, role: string) {
  const row = await queryOne<CardRow>('SELECT * FROM approval_cards WHERE id = $1', [id]);
  if (!row) throw new ApprovalCardError('NOT_FOUND', 'approval card not found');
  await assertCardVisible(row, userId, role);
  const revision = await queryOne<RevisionRow>('SELECT * FROM approval_card_revisions WHERE card_id = $1 AND revision_no = $2', [id, row.current_revision_no]);
  const attachments = await query<AttachmentRow>('SELECT * FROM approval_card_attachments WHERE card_id = $1 AND revision_no = $2 ORDER BY created_at ASC', [id, row.current_revision_no]);
  const events = await query<EventRow>('SELECT * FROM approval_card_events WHERE card_id = $1 ORDER BY created_at ASC', [id]);
  return mapCard(row, revision, attachments, events);
}

async function assertCurrentFiles(cardId: string, revisionNo: number, userId: number, role: string): Promise<void> {
  const attachments = await query<AttachmentRow>(`SELECT * FROM approval_card_attachments WHERE card_id = $1 AND revision_no = $2 AND attachment_type = 'file'`, [cardId, revisionNo]);
  for (const attachment of attachments) {
    const filePath = attachment.payload?.path;
    if (typeof filePath !== 'string' || !await isPathAccessible(filePath, userId, role)) throw new ApprovalCardError('FORBIDDEN', 'file attachment is no longer accessible');
    const current = await sha256File(filePath).catch(() => null);
    if (!current || current !== attachment.content_hash) throw new ApprovalCardError('STALE', 'an attached file changed after submission; resubmission is required');
  }
}

/** Resolve a pending card. Approval verifies immutable file hashes before changing state. */
export async function resolveApprovalCard(input: { id: string; userId: number; role: string; resolution: ApprovalResolution; commentMd?: string }) {
  const row = await queryOne<CardRow>('SELECT * FROM approval_cards WHERE id = $1', [input.id]);
  if (!row) throw new ApprovalCardError('NOT_FOUND', 'approval card not found');
  if (!isPrivilegedRole(input.role) && row.approver_user_id !== input.userId) throw new ApprovalCardError('FORBIDDEN', 'only the assigned approver can resolve this card');
  if (row.status !== 'pending') throw new ApprovalCardError('CONFLICT', `card is already ${row.status}`);
  if (input.resolution === 'approved') {
    try { await assertCurrentFiles(row.id, row.current_revision_no, input.userId, input.role); }
    catch (err) {
      if (err instanceof ApprovalCardError && err.code === 'STALE') {
        await transaction(async (client) => {
          const db = withClient(client);
          await db.execute(`UPDATE approval_cards SET status = 'stale' WHERE id = $1 AND status = 'pending'`, [row.id]);
          await db.execute(`INSERT INTO approval_card_events (card_id, actor_user_id, event_type, payload) VALUES ($1,$2,'stale_detected',$3::jsonb)`, [row.id, input.userId, JSON.stringify({ revisionNo: row.current_revision_no, message: err.message })]);
        });
      }
      throw err;
    }
  }
  const commentMd = cleanText(input.commentMd, 50_000);
  const eventType = input.resolution === 'approved' ? 'approved' : input.resolution;
  await transaction(async (client) => {
    const db = withClient(client);
    const result = await client.query(`UPDATE approval_cards SET status = $1, resolved_by_user_id = $2, resolved_at = NOW() WHERE id = $3 AND status = 'pending' RETURNING id`, [input.resolution, input.userId, input.id]);
    if (!result.rowCount) throw new ApprovalCardError('CONFLICT', 'card was resolved by another request');
    await db.execute(`INSERT INTO approval_card_events (card_id, actor_user_id, event_type, payload) VALUES ($1,$2,$3,$4::jsonb)`, [input.id, input.userId, eventType, JSON.stringify({ revisionNo: row.current_revision_no, commentMd: commentMd || null })]);
  });
  return await getApprovalCard(input.id, input.userId, input.role);
}

/** Append the next immutable revision after changes were requested or a stale file was detected. */
export async function resubmitApprovalCard(input: { id: string; userId: number; role: string; summaryMd: string; recommendationMd?: string; consequenceMd: string; options?: Array<{ id: string; label: string }>; attachments?: ApprovalAttachmentInput[] }) {
  const row = await queryOne<CardRow>('SELECT * FROM approval_cards WHERE id = $1', [input.id]);
  if (!row) throw new ApprovalCardError('NOT_FOUND', 'approval card not found');
  if (!isPrivilegedRole(input.role) && row.submitter_user_id !== input.userId) throw new ApprovalCardError('FORBIDDEN', 'only the submitter can resubmit this card');
  if (!['changes_requested', 'stale'].includes(row.status)) throw new ApprovalCardError('CONFLICT', 'card is not awaiting resubmission');
  const summaryMd = cleanText(input.summaryMd, 100_000, true);
  const recommendationMd = cleanText(input.recommendationMd, 50_000);
  const consequenceMd = cleanText(input.consequenceMd, 50_000, true);
  const options = Array.isArray(input.options) ? input.options.slice(0, 12).map((o) => ({ id: cleanText(o?.id, 80, true), label: cleanText(o?.label, 160, true) })) : [];
  const attachments: Awaited<ReturnType<typeof normalizeAttachment>>[] = [];
  for (const item of input.attachments || []) attachments.push(await normalizeAttachment(item, { userId: input.userId, role: input.role, projectId: row.project_id }));
  const next = row.current_revision_no + 1;
  await transaction(async (client) => {
    const db = withClient(client);
    await db.execute(`INSERT INTO approval_card_revisions (card_id, revision_no, summary_md, recommendation_md, consequence_md, options, submitted_by_user_id) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`, [row.id, next, summaryMd, recommendationMd || null, consequenceMd, JSON.stringify(options), input.userId]);
    for (const item of attachments) await db.execute(`INSERT INTO approval_card_attachments (card_id, revision_no, attachment_type, label, payload, content_hash) VALUES ($1,$2,$3,$4,$5::jsonb,$6)`, [row.id, next, item.type, item.label || null, JSON.stringify(item.payload), item.contentHash]);
    const updated = await client.query(`UPDATE approval_cards SET current_revision_no = $1, status = 'pending', resolved_by_user_id = NULL, resolved_at = NULL WHERE id = $2 AND current_revision_no = $3 AND status IN ('changes_requested','stale') RETURNING id`, [next, row.id, row.current_revision_no]);
    if (!updated.rowCount) throw new ApprovalCardError('CONFLICT', 'card changed before resubmission');
    await db.execute(`INSERT INTO approval_card_events (card_id, actor_user_id, event_type, payload) VALUES ($1,$2,'resubmitted',$3::jsonb)`, [row.id, input.userId, JSON.stringify({ revisionNo: next })]);
  });
  return await getApprovalCard(row.id, input.userId, input.role);
}
