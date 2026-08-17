// Owns: Conversation-scoped external user file storage and searchable representations.
// Public API: save, list, delete, and build snapshot for the current Conversation.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execute, query, queryOne } from '../../db/pg-repo.js';

const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CONVERSATION_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.txt', '.csv']);

export interface ConversationFilePublic {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  createdAt: string;
}

type ConversationScope = {
  service_id: string; deployment_id: string; channel_id: string; tenant_key: string; user_key: string; root_path: string;
};

function safeId(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function fileExtension(name: string): string {
  return path.extname(name).toLowerCase();
}

function normalizeText(bytes: Buffer): string {
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (text.includes('\u0000')) throw new Error('File contains unsupported binary content');
  return text;
}

function representationFor(input: { fileId: string; originalName: string; sha256: string; text: string }) {
  const lines = input.text.split('\n');
  const units: Array<{ locator: string; startLine: number; endLine: number; text: string }> = [];
  for (let start = 0; start < lines.length; start += 80) {
    const slice = lines.slice(start, start + 80);
    if (!slice.some((line) => line.trim())) continue;
    units.push({ locator: `L${start + 1}-L${start + slice.length}`, startLine: start + 1, endLine: start + slice.length, text: slice.join('\n') });
  }
  return { documentId: `conversation_doc_${input.fileId}`, originalName: input.originalName, sha256: input.sha256, units };
}

async function scope(input: { conversationId: string; channelId: string; tenantKey: string; userKey: string }): Promise<ConversationScope> {
  const row = await queryOne<ConversationScope>(`SELECT c.service_id,c.deployment_id,c.channel_id,c.tenant_key,c.user_key,p.root_path
    FROM ai_service_conversations c
    JOIN ai_services s ON s.id=c.service_id AND s.status='active'
    JOIN ai_service_channels ch ON ch.id=c.channel_id AND ch.service_id=c.service_id AND ch.status='enabled'
    JOIN ai_service_deployments d ON d.id=c.deployment_id AND d.service_id=c.service_id AND d.status IN ('active','superseded')
    JOIN projects p ON p.id=s.owner_project_id
    WHERE c.id=$1 AND c.channel_id=$2 AND c.tenant_key=$3 AND c.user_key=$4 AND c.status='open'`,
  [input.conversationId, input.channelId, input.tenantKey, input.userKey]);
  if (!row?.root_path) throw new Error('AI service Conversation file scope is unavailable');
  return row;
}

/** Save a staged TXT/CSV file under the owning Project's ext-user-data folder. */
export async function saveConversationFile(input: { conversationId: string; channelId: string; tenantKey: string; userKey: string; stagedPath: string; originalName: string; mimeType: string; sizeBytes: number }): Promise<ConversationFilePublic> {
  if (input.sizeBytes <= 0 || input.sizeBytes > MAX_FILE_BYTES) throw new Error('File must be between 1 byte and 10MB');
  const extension = fileExtension(input.originalName);
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error('This first version supports TXT and CSV files only');
  const owner = await scope(input);
  const usage = await queryOne<{ count: string; total: string }>(`SELECT COUNT(*)::text AS count,COALESCE(SUM(size_bytes),0)::text AS total FROM ai_service_conversation_files WHERE conversation_id=$1 AND deleted_at IS NULL`, [input.conversationId]);
  if (Number(usage?.count || 0) >= MAX_FILES) throw new Error('This Conversation already has 5 files');
  if (Number(usage?.total || 0) + input.sizeBytes > MAX_CONVERSATION_BYTES) throw new Error('Conversation files exceed 25MB total');

  const fileId = crypto.randomUUID();
  const relativeDir = path.posix.join('ext-user-data', 'ai-services', safeId(owner.service_id, 'serviceId'), 'conversations', safeId(input.conversationId, 'conversationId'), 'files', safeId(fileId, 'fileId'));
  const absoluteDir = path.join(owner.root_path, ...relativeDir.split('/'));
  const originalPath = path.join(absoluteDir, 'original');
  const representationPath = path.join(absoluteDir, 'representation.json');
  await fs.mkdir(absoluteDir, { recursive: true });
  const bytes = await fs.readFile(input.stagedPath);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const representation = representationFor({ fileId, originalName: input.originalName, sha256, text: normalizeText(bytes) });
  await fs.copyFile(input.stagedPath, originalPath, fs.constants.COPYFILE_EXCL);
  await fs.writeFile(representationPath, `${JSON.stringify(representation)}\n`, { flag: 'wx', mode: 0o600 });
  await execute(`INSERT INTO ai_service_conversation_files(id,service_id,deployment_id,channel_id,conversation_id,tenant_key,user_key,project_relative_path,representation_path,original_name,mime_type,size_bytes,sha256,processing_status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'ready')`,
  [fileId, owner.service_id, owner.deployment_id, owner.channel_id, input.conversationId, owner.tenant_key, owner.user_key, path.posix.join(relativeDir, 'original'), path.posix.join(relativeDir, 'representation.json'), input.originalName.slice(0, 240), input.mimeType || 'text/plain', input.sizeBytes, sha256]);
  return { id: fileId, name: input.originalName, mimeType: input.mimeType || 'text/plain', sizeBytes: input.sizeBytes, status: 'ready', createdAt: new Date().toISOString() };
}

/** List only files owned by the exact current Conversation identity. */
export async function listConversationFiles(input: { conversationId: string; channelId: string; tenantKey: string; userKey: string }): Promise<ConversationFilePublic[]> {
  await scope(input);
  const rows = await query<Omit<ConversationFilePublic, 'sizeBytes'> & { sizeBytes: string | number }>(`SELECT id,original_name AS name,mime_type AS "mimeType",size_bytes::bigint AS "sizeBytes",processing_status AS status,created_at AS "createdAt"
    FROM ai_service_conversation_files WHERE conversation_id=$1 AND channel_id=$2 AND tenant_key=$3 AND user_key=$4 AND deleted_at IS NULL ORDER BY created_at`,
  [input.conversationId, input.channelId, input.tenantKey, input.userKey]);
  return rows.map((row) => ({ ...row, sizeBytes: Number(row.sizeBytes) }));
}

/** Delete bytes and remove them from future Conversation search. */
export async function deleteConversationFile(input: { fileId: string; conversationId: string; channelId: string; tenantKey: string; userKey: string }): Promise<void> {
  const owner = await scope(input);
  const row = await queryOne<{ project_relative_path: string; representation_path: string }>(`SELECT project_relative_path,representation_path FROM ai_service_conversation_files
    WHERE id=$1 AND conversation_id=$2 AND channel_id=$3 AND tenant_key=$4 AND user_key=$5 AND deleted_at IS NULL`,
  [input.fileId, input.conversationId, input.channelId, input.tenantKey, input.userKey]);
  if (!row) throw new Error('Conversation file not found');
  const originalPath = path.join(owner.root_path, ...row.project_relative_path.split('/'));
  await fs.rm(path.dirname(originalPath), { recursive: true, force: true });
  await execute(`UPDATE ai_service_conversation_files SET processing_status='deleted',deleted_at=NOW() WHERE id=$1`, [input.fileId]);
}

/** Build an immutable-in-memory Knowledge snapshot from ready files of the exact Conversation. */
export async function conversationFilesSnapshot(conversationId: string): Promise<unknown | undefined> {
  const rows = await query<{ id: string; original_name: string; representation_path: string; root_path: string }>(`SELECT f.id,f.original_name,f.representation_path,p.root_path
    FROM ai_service_conversation_files f JOIN ai_services s ON s.id=f.service_id JOIN projects p ON p.id=s.owner_project_id
    WHERE f.conversation_id=$1 AND f.processing_status='ready' AND f.deleted_at IS NULL ORDER BY f.created_at`, [conversationId]);
  if (!rows.length) return undefined;
  const refs = [];
  for (const row of rows) {
    const representation = JSON.parse(await fs.readFile(path.join(row.root_path, ...row.representation_path.split('/')), 'utf8')) as { sha256: string; units: Array<{ startLine: number; endLine: number; text: string }> };
    refs.push({ path: `conversation-files/${row.id}/${row.original_name}`, title: row.original_name, sha256: representation.sha256, content: representation.units.map((unit) => unit.text).join('\n'), sizeBytes: Buffer.byteLength(representation.units.map((unit) => unit.text).join('\n'), 'utf8') });
  }
  return { kind: 'knowledge', version: 1, refs, userFacingLabel: '이 대화에 업로드한 자료' };
}
