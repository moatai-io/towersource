/**
 * Owns: hashed resume grants and public-safe history reads for AI Service Conversations.
 * Public API: issueConversationResumeGrant, resumeConversation. See README.md.
 */
import crypto from 'node:crypto';
import { execute, query, queryOne } from '../../db/pg-repo.js';

const TOKEN_PREFIX = 'tasr_v1';
const DEFAULT_TTL_DAYS = 90;
const MAX_MESSAGES = 200;

export interface ResumedConversation {
  id: string;
  deploymentId: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; text: string; createdAt: string }>;
}

function tokenHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function required(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} required`);
  if (normalized.length > 240) throw new Error(`${label} exceeds 240 characters`);
  return normalized;
}

/** Issue a bearer resume credential once; only its SHA-256 hash is persisted. */
export async function issueConversationResumeGrant(input: {
  conversationId: string;
  serviceId: string;
  channelId: string;
  tenantKey: string;
  userKey: string;
  ttlDays?: number;
}): Promise<{ resumeToken: string; expiresAt: string }> {
  const random = crypto.randomBytes(32).toString('base64url');
  const resumeToken = `${TOKEN_PREFIX}.${random}`;
  const ttlDays = Math.max(1, Math.min(365, Math.floor(input.ttlDays || DEFAULT_TTL_DAYS)));
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  await execute(
    `INSERT INTO ai_service_conversation_resume_grants
       (conversation_id,service_id,channel_id,tenant_key,user_key,token_hash,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [required(input.conversationId, 'conversationId'), required(input.serviceId, 'serviceId'), required(input.channelId, 'channelId'),
      required(input.tenantKey, 'tenantKey'), required(input.userKey, 'userKey'), tokenHash(resumeToken), expiresAt],
  );
  return { resumeToken, expiresAt };
}

function messageText(content: unknown): string {
  const row = content && typeof content === 'object' && !Array.isArray(content) ? content as Record<string, unknown> : {};
  if (typeof row.text === 'string') return row.text;
  if (typeof row.answer === 'string') return row.answer;
  return '';
}

/** Validate token + current browser identity + Channel scope before returning bounded public history. */
export async function resumeConversation(input: {
  conversationId: string;
  channelId: string;
  tenantKey: string;
  userKey: string;
  resumeToken: string;
}): Promise<ResumedConversation> {
  const conversationId = required(input.conversationId, 'conversationId');
  const channelId = required(input.channelId, 'channelId');
  const tenantKey = required(input.tenantKey, 'tenantKey');
  const userKey = required(input.userKey, 'userKey');
  const resumeToken = required(input.resumeToken, 'resumeToken');
  if (!resumeToken.startsWith(`${TOKEN_PREFIX}.`)) throw new Error('AI service Conversation resume credential is invalid');
  const row = await queryOne<{ id: string; deployment_id: string }>(
    `SELECT x.id,x.deployment_id
       FROM ai_service_conversation_resume_grants g
       JOIN ai_service_conversations x ON x.id=g.conversation_id AND x.service_id=g.service_id AND x.channel_id=g.channel_id
       JOIN ai_service_channels c ON c.id=x.channel_id AND c.service_id=x.service_id
       JOIN ai_services s ON s.id=x.service_id
      WHERE g.conversation_id=$1 AND g.channel_id=$2 AND g.tenant_key=$3 AND g.user_key=$4 AND g.token_hash=$5
        AND g.revoked_at IS NULL AND g.expires_at>NOW() AND x.status='open' AND c.status='enabled' AND s.status='active'`,
    [conversationId, channelId, tenantKey, userKey, tokenHash(resumeToken)],
  );
  if (!row) throw new Error('AI service Conversation resume credential is invalid or expired');
  await execute('UPDATE ai_service_conversation_resume_grants SET last_used_at=NOW() WHERE token_hash=$1', [tokenHash(resumeToken)]);
  const messages = await query<{ role: string; content: unknown; created_at: string }>(
    `SELECT role,content,created_at
       FROM ai_service_conversation_messages
      WHERE conversation_id=$1 AND channel_id=$2 AND role IN ('user','assistant','system')
      ORDER BY created_at ASC,id ASC LIMIT $3`,
    [conversationId, channelId, MAX_MESSAGES],
  );
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    messages: messages.flatMap((message) => {
      const role = message.role === 'user' || message.role === 'assistant' || message.role === 'system' ? message.role : null;
      const text = messageText(message.content);
      return role && text ? [{ role, text, createdAt: String(message.created_at) }] : [];
    }),
  };
}
