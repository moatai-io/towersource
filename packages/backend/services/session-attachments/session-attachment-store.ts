// Owns: user/session-scoped attachment bytes, metadata, and explicit promotion.
// Public API: create/get/list/delete/promote session attachment helpers. See README.md.
import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { config } from '../../config.js';
import { execute, query, queryOne } from '../../db/pg-repo.js';
import { getUserAuthState } from '../auth/auth.js';
import { canAccessSession, canWriteSessionContent } from '../pm/project-access.js';
import { getProject } from '../pm/project-manager.js';
import { isPathWritableByRole } from '../pm/project-access.js';
import { createPersonalBinaryFile } from '../personal-space/personal-space-store.js';

const SESSION_URI_RE = /^session:\/\/attachments\/([0-9a-f-]{36})$/i;
const MAX_NAME_LENGTH = 240;
const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;

interface SessionAttachmentRow {
  id: string;
  owner_user_id: number;
  session_id: string;
  project_id: string | null;
  original_name: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: string | number;
  status: 'temporary' | 'promoted_personal' | 'promoted_project' | 'deleted';
  promoted_uri: string | null;
  expires_at: string;
  created_at: string;
}

export interface SessionAttachmentDocument {
  id: string;
  uri: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number;
  status: SessionAttachmentRow['status'];
  promotedUri: string | null;
  expiresAt: string;
  createdAt: string;
}

export class SessionAttachmentError extends Error {
  constructor(public code: 'INVALID' | 'NOT_FOUND' | 'FORBIDDEN' | 'EXPIRED' | 'CONFLICT', message: string) {
    super(message);
    this.name = 'SessionAttachmentError';
  }
}

function validateId(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new SessionAttachmentError('INVALID', `Invalid ${label}`);
}

function safeName(input: string): string {
  const normalized = path.basename(String(input || '').trim()).normalize('NFC').replace(/[\\/:*?"<>|\0]/g, '-');
  const extension = path.extname(normalized);
  const suffix = Buffer.byteLength(extension) <= 32 ? extension : '';
  const stem = suffix ? normalized.slice(0, -suffix.length) : normalized;
  let base = '';
  for (const character of stem) {
    if (Buffer.byteLength(base + character + suffix) > MAX_NAME_LENGTH) break;
    base += character;
  }
  base += suffix;
  if (!base || base === '.' || base === '..') throw new SessionAttachmentError('INVALID', 'Attachment filename required');
  return base;
}

function attachmentRoot(userId: number, sessionId: string): string {
  validateId(userId, 'user');
  if (!sessionId?.trim()) throw new SessionAttachmentError('INVALID', 'Session required');
  return path.join(config.dataDir, 'session-attachments', String(userId), sessionId);
}

function toDocument(row: SessionAttachmentRow): SessionAttachmentDocument {
  return {
    id: row.id,
    uri: `session://attachments/${row.id}`,
    name: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    promotedUri: row.promoted_uri,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export function sessionAttachmentIdFromUri(uri: string): string {
  const match = SESSION_URI_RE.exec(String(uri || '').trim());
  if (!match) throw new SessionAttachmentError('INVALID', 'Invalid session attachment URI');
  return match[1];
}

export async function createSessionAttachmentFromPath(input: {
  userId: number;
  sessionId: string;
  projectId?: string | null;
  name: string;
  mimeType?: string | null;
  sourcePath: string;
}): Promise<SessionAttachmentDocument> {
  validateId(input.userId, 'user');
  const sourceStat = await fs.stat(input.sourcePath);
  if (!sourceStat.isFile()) throw new SessionAttachmentError('INVALID', 'Attachment source must be a regular file');
  if (sourceStat.size > MAX_ATTACHMENT_BYTES) throw new SessionAttachmentError('INVALID', 'Attachment is too large');
  const name = safeName(input.name);
  const id = crypto.randomUUID();
  const root = attachmentRoot(input.userId, input.sessionId);
  await fs.mkdir(root, { recursive: true });
  const storagePath = path.join(root, id, name);
  await fs.mkdir(path.dirname(storagePath), { recursive: true });
  try {
    const hash = crypto.createHash('sha256');
    const source = (await import('node:fs')).createReadStream(input.sourcePath);
    source.on('data', chunk => hash.update(chunk));
    const target = (await import('node:fs')).createWriteStream(storagePath, { flags: 'wx', mode: 0o600 });
    await (await import('node:stream/promises')).pipeline(source, target);
    const digest = hash.digest('hex');
    const row = await queryOne<SessionAttachmentRow>(
      `INSERT INTO session_attachments
         (id, owner_user_id, session_id, project_id, original_name, storage_path, mime_type, size_bytes, content_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *, expires_at::text, created_at::text`,
      [id, input.userId, input.sessionId, input.projectId || null, name, storagePath, input.mimeType || null, sourceStat.size, digest],
    );
    if (!row) throw new Error('Attachment metadata insert failed');
    return toDocument(row);
  } catch (error) {
    await fs.rm(path.join(root, id), { recursive: true, force: true });
    throw error;
  }
}

/** Persist bytes outside project workspaces and bind them to one owner + session. */
export async function createSessionAttachment(input: {
  userId: number;
  sessionId: string;
  projectId?: string | null;
  name: string;
  mimeType?: string | null;
  content: Buffer;
}): Promise<SessionAttachmentDocument> {
  validateId(input.userId, 'user');
  if (input.content.length > MAX_ATTACHMENT_BYTES) throw new SessionAttachmentError('INVALID', 'Attachment is too large');
  const name = safeName(input.name);
  const id = crypto.randomUUID();
  const root = attachmentRoot(input.userId, input.sessionId);
  await fs.mkdir(root, { recursive: true });
  const storagePath = path.join(root, id, name);
  await fs.mkdir(path.dirname(storagePath), { recursive: true });
  await fs.writeFile(storagePath, input.content, { flag: 'wx', mode: 0o600 });
  const digest = crypto.createHash('sha256').update(input.content).digest('hex');
  try {
    const row = await queryOne<SessionAttachmentRow>(
      `INSERT INTO session_attachments
         (id, owner_user_id, session_id, project_id, original_name, storage_path, mime_type, size_bytes, content_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *, expires_at::text, created_at::text`,
      [id, input.userId, input.sessionId, input.projectId || null, name, storagePath, input.mimeType || null, input.content.length, digest],
    );
    if (!row) throw new Error('Attachment metadata insert failed');
    return toDocument(row);
  } catch (error) {
    await fs.rm(path.join(root, id), { recursive: true, force: true });
    throw error;
  }
}

async function resolveAttachmentRow(row: SessionAttachmentRow | undefined, sessionId: string): Promise<{ document: SessionAttachmentDocument; path: string }> {
  if (!row) throw new SessionAttachmentError('NOT_FOUND', 'Session attachment not found');
  if (new Date(row.expires_at).getTime() <= Date.now()) throw new SessionAttachmentError('EXPIRED', 'Session attachment expired');
  const root = path.resolve(attachmentRoot(row.owner_user_id, sessionId));
  const resolved = path.resolve(row.storage_path);
  if (!resolved.startsWith(root + path.sep)) throw new SessionAttachmentError('FORBIDDEN', 'Attachment storage escaped its session root');
  await fs.stat(resolved).catch(() => { throw new SessionAttachmentError('NOT_FOUND', 'Session attachment file missing'); });
  await execute('UPDATE session_attachments SET last_accessed_at = NOW() WHERE id = $1', [row.id]);
  return { document: toDocument(row), path: resolved };
}

/** Resolve a temporary attachment only when both owner and session match. */
export async function resolveSessionAttachment(userId: number, sessionId: string, uriOrId: string): Promise<{ document: SessionAttachmentDocument; path: string }> {
  validateId(userId, 'user');
  const id = uriOrId.startsWith('session://') ? sessionAttachmentIdFromUri(uriOrId) : uriOrId;
  const row = await queryOne<SessionAttachmentRow>(
    `SELECT *, expires_at::text, created_at::text FROM session_attachments
      WHERE id = $1 AND owner_user_id = $2 AND session_id = $3 AND status <> 'deleted'`,
    [id, userId, sessionId],
  );
  return resolveAttachmentRow(row, sessionId);
}

/** Shared-session inspection still requires live account and session authorization. */
export async function resolveAuthorizedSessionAttachment(userId: number, sessionId: string, uriOrId: string) {
  const auth = await getUserAuthState(userId);
  if (!auth || auth.disabled || auth.approvalStatus !== 'active') throw new SessionAttachmentError('FORBIDDEN', 'Session attachment access denied');
  const access = await canAccessSession(sessionId, userId, auth.role);
  if (!access.allowed) throw new SessionAttachmentError('FORBIDDEN', 'Session attachment access denied');
  const id = uriOrId.startsWith('session://') ? sessionAttachmentIdFromUri(uriOrId) : uriOrId;
  return resolveReadableSessionAttachment(sessionId, id);
}

/** Resolve bytes after the caller has independently passed the session read-access check. */
export async function resolveReadableSessionAttachment(sessionId: string, uriOrId: string): Promise<{ document: SessionAttachmentDocument; path: string }> {
  const id = uriOrId.startsWith('session://') ? sessionAttachmentIdFromUri(uriOrId) : uriOrId;
  const row = await queryOne<SessionAttachmentRow>(
    `SELECT *, expires_at::text, created_at::text FROM session_attachments
      WHERE id = $1 AND session_id = $2 AND status <> 'deleted'`,
    [id, sessionId],
  );
  return resolveAttachmentRow(row, sessionId);
}

export async function listSessionAttachments(userId: number, sessionId: string): Promise<SessionAttachmentDocument[]> {
  const rows = await query<SessionAttachmentRow>(
    `SELECT *, expires_at::text, created_at::text FROM session_attachments
      WHERE owner_user_id = $1 AND session_id = $2 AND status <> 'deleted' AND expires_at > NOW()
      ORDER BY session_attachments.created_at DESC`,
    [userId, sessionId],
  );
  return rows.map(toDocument);
}

/** Remove expired source snapshots; promoted destination copies are preserved independently. */
export async function purgeExpiredSessionAttachments(limit = 200): Promise<number> {
  const rows = await query<SessionAttachmentRow>(
    `SELECT *, expires_at::text, created_at::text FROM session_attachments
      WHERE status <> 'deleted' AND expires_at <= NOW()
      ORDER BY session_attachments.expires_at ASC LIMIT $1`,
    [Math.max(1, Math.min(limit, 1000))],
  );
  for (const row of rows) {
    const root = path.resolve(attachmentRoot(row.owner_user_id, row.session_id));
    const resolved = path.resolve(row.storage_path);
    if (resolved.startsWith(root + path.sep)) await fs.rm(path.dirname(resolved), { recursive: true, force: true });
  }
  if (rows.length > 0) {
    await execute(
      `UPDATE session_attachments SET status = 'deleted', updated_at = NOW() WHERE id = ANY($1::uuid[])`,
      [rows.map(row => row.id)],
    );
  }
  return rows.length;
}

export async function deleteSessionAttachment(userId: number, sessionId: string, id: string): Promise<void> {
  const resolved = await resolveSessionAttachment(userId, sessionId, id);
  await fs.rm(path.dirname(resolved.path), { recursive: true, force: true });
  await execute("UPDATE session_attachments SET status = 'deleted', updated_at = NOW() WHERE id = $1", [resolved.document.id]);
}

/** Copy one temporary attachment into owner-only Personal Space. */
export async function promoteSessionAttachmentToPersonal(input: {
  userId: number;
  sessionId: string;
  attachmentId: string;
  requestedName?: string;
}): Promise<SessionAttachmentDocument> {
  const resolved = await resolveSessionAttachment(input.userId, input.sessionId, input.attachmentId);
  const content = await fs.readFile(resolved.path);
  const personal = await createPersonalBinaryFile(
    input.userId,
    `files/${safeName(input.requestedName || resolved.document.name)}`,
    content,
    resolved.document.mimeType,
  );
  const row = await queryOne<SessionAttachmentRow>(
    `UPDATE session_attachments SET status = 'promoted_personal', promoted_uri = $2, updated_at = NOW()
      WHERE id = $1 RETURNING *, expires_at::text, created_at::text`,
    [resolved.document.id, personal.uri],
  );
  return toDocument(row!);
}

/** Copy one temporary attachment to the current project. Original remains session-scoped until TTL. */
export async function promoteSessionAttachmentToProject(input: {
  userId: number;
  userRole: string;
  sessionId: string;
  attachmentId: string;
  projectId: string;
  requestedName?: string;
}): Promise<SessionAttachmentDocument> {
  const current = await getUserAuthState(input.userId);
  if (!current || current.disabled || current.approvalStatus !== 'active') throw new SessionAttachmentError('FORBIDDEN', 'Session attachment save denied');
  const writable = await canWriteSessionContent(input.sessionId, input.userId, current.role);
  if (!writable.allowed) throw new SessionAttachmentError('FORBIDDEN', 'Session attachment save denied');
  const resolved = await resolveAuthorizedSessionAttachment(input.userId, input.sessionId, input.attachmentId);
  const project = await getProject(input.projectId);
  if (!project?.rootPath) throw new SessionAttachmentError('NOT_FOUND', 'Project not found');
  const targetDir = path.join(project.rootPath, 'uploads');
  if (!await isPathWritableByRole(targetDir, input.userId, input.userRole)) throw new SessionAttachmentError('FORBIDDEN', 'Project upload access denied');
  // Lazy import avoids a module initialization cycle with SessionAttachmentError.
  const { commitStagedProjectUpload } = await import('./project-attachment-upload.js');
  const saved = await commitStagedProjectUpload({
    sourcePath: resolved.path,
    originalName: input.requestedName || resolved.document.name,
    mimeType: resolved.document.mimeType,
    sizeBytes: resolved.document.sizeBytes,
    projectId: input.projectId,
    userId: input.userId,
    userRole: current.role,
  });
  const target = saved.uri;
  const row = await queryOne<SessionAttachmentRow>(
    `UPDATE session_attachments SET status = 'promoted_project', promoted_uri = $2, updated_at = NOW()
      WHERE id = $1 RETURNING *, expires_at::text, created_at::text`,
    [resolved.document.id, target],
  );
  return toDocument(row!);
}
