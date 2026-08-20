import { query, queryOne, execute } from '../db/pg-repo.js';
import { extractTextFromContent } from '../utils/text.js';
import { recordMessagePaths } from './workspace/message-path-extractor.js';
import { hasAssistantArtifactCandidate, materializeAssistantArtifactBlocks, normalizeAssistantArtifactBlocks } from './workspace/assistant-artifact-blocks.js';
import { generateShortCode } from './session/short-code.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { forceAgentTurnNeedsAttention, registerAgentTurn, settleAgentTurn, updateUnclaimedAgentTurn } from './agent-turn/turn-supervisor.js';
import { sanitizeEmbeddedBinaryText } from './content-safety/embedded-binary.js';
import { indexWorkReportMessage, indexWorkReportMessageUpdate } from './work/work-report-ledger.js';

const PG_UNIQUE_VIOLATION = '23505';
const PG_UNDEFINED_COLUMN = '42703';
const SHORT_ID_MAX_RETRIES = 5;

let messageSeqAvailable: boolean | null = null;

async function hasMessageSeq(): Promise<boolean> {
  if (messageSeqAvailable !== null) return messageSeqAvailable;
  try {
    await queryOne(`SELECT message_seq FROM messages LIMIT 0`);
    messageSeqAvailable = true;
  } catch (error: any) {
    if (error?.code !== PG_UNDEFINED_COLUMN) throw error;
    messageSeqAvailable = false;
  }
  return messageSeqAvailable;
}

export function resetMessageOrderingCapabilityForTests(): void {
  messageSeqAvailable = null;
}

const BLOB_DIR = path.join(process.cwd(), 'data', 'blobs');

// Threshold above which base64 binary content is extracted to disk
const BLOB_THRESHOLD = 8 * 1024; // 8 KB of base64 text
// Durable assistant tool traces can carry Pi's tool output on `tool_use.result`.
// Keep this aligned with the user-facing bash contract so one noisy command
// cannot inflate the DB row and every later provider request by megabytes.
const TOOL_USE_RESULT_MAX_CHARS = 50 * 1024;

function truncateToolUseResult(text: string): string {
  const sanitized = sanitizeEmbeddedBinaryText(text);
  if (sanitized.length <= TOOL_USE_RESULT_MAX_CHARS) return sanitized;

  const marker = `\n\n... [tool output truncated ${(sanitized.length / 1024).toFixed(0)}KB → 50KB] ...\n\n`;
  const remaining = TOOL_USE_RESULT_MAX_CHARS - marker.length;
  const headLength = Math.ceil(remaining / 2);
  const tailLength = Math.floor(remaining / 2);
  return sanitized.slice(0, headLength) + marker + sanitized.slice(-tailLength);
}

export interface StoredMessage {
  id: string;
  session_id: string;
  role: string;
  content: string; // JSON string of ContentBlock[]
  parent_tool_use_id?: string | null;
  username?: string | null;
  message_seq?: number;
  created_at?: string;
  updated_at?: string | null;
  completed_at?: string | null;
  duration_ms?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  /** Hidden flags / debug markers. See migration 055. */
  metadata?: Record<string, any> | null;
  /**
   * URL anchor token (8자 base32) — `/s/<sessionShortCode>#m-<shortId>` 형태로
   * 메시지 직접 링크. (session_id, short_id) composite unique — 세션 안에서만 유효.
   * 마이그레이션 069 적용 후 신규 메시지는 항상 발급, 기존은 부팅 시 backfill.
   * 결정: issue #11 Phase 3 메시지 앵커.
   */
  short_id?: string | null;
}

/**
 * Strip bloat from content blocks before saving to DB:
 * 1. Remove `thinking` blocks (not needed for display or resume)
 * 2. Extract large base64 images/PDFs to disk, replace with file reference
 * 3. Truncate large tool_result text (keep first/last 2KB)
 * 4. Truncate Pi-style tool_use.result traces to the 50KB bash output contract
 */
function compactContent(blocks: any[]): any[] {
  if (!Array.isArray(blocks)) return blocks;

  const result: any[] = [];
  for (const block of blocks) {
    // 1. Strip private assistant channels. User-visible commentary is assistant
    // prose with phase metadata and is kept; hidden commentary and thinking
    // remain out of the durable transcript.
    if (block.type === 'thinking') continue;
    if (block.type === 'commentary') {
      if (block.visibility !== 'progress' || typeof block.text !== 'string' || !block.text.trim()) continue;
      const sanitized = sanitizeEmbeddedBinaryText(block.text);
      result.push({ type: 'commentary', text: sanitized, phase: 'commentary', visibility: 'progress' });
      continue;
    }

    // 2. Extract base64 sources (images, PDFs) to disk
    if (block.type === 'image' && block.source?.type === 'base64' && block.source.data) {
      const data = block.source.data as string;
      if (data.length > BLOB_THRESHOLD) {
        const blobRef = extractBlobToDisk(data, block.source.media_type || 'image/png');
        if (blobRef) {
          result.push({ ...block, source: { type: 'blob_ref', path: blobRef, media_type: block.source.media_type } });
          continue;
        }
      }
    }

    // 2b. Base64 in document blocks (PDFs)
    if (block.type === 'document' && block.source?.type === 'base64' && block.source.data) {
      const data = block.source.data as string;
      if (data.length > BLOB_THRESHOLD) {
        const blobRef = extractBlobToDisk(data, block.source.media_type || 'application/pdf');
        if (blobRef) {
          result.push({ ...block, source: { type: 'blob_ref', path: blobRef, media_type: block.source.media_type } });
          continue;
        }
      }
    }

    // 2c. Base64 images inside tool_result content arrays
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      const compactedInner = block.content.map((inner: any) => {
        if (inner.type === 'image' && inner.source?.type === 'base64' && inner.source.data?.length > BLOB_THRESHOLD) {
          const blobRef = extractBlobToDisk(inner.source.data, inner.source.media_type || 'image/png');
          if (blobRef) {
            return { ...inner, source: { type: 'blob_ref', path: blobRef, media_type: inner.source.media_type } };
          }
        }
        return inner;
      });
      result.push({ ...block, content: compactedInner });
      continue;
    }

    // 3. Sanitize opaque binary embedded in textual tool results, then truncate.
    if (block.type === 'tool_result' && typeof block.content === 'string') {
      const sanitized = sanitizeEmbeddedBinaryText(block.content);
      if (sanitized.length > BLOB_THRESHOLD) {
        const truncated = sanitized.slice(0, 2048) + `\n\n... [truncated ${(sanitized.length / 1024).toFixed(0)}KB → 4KB] ...\n\n` + sanitized.slice(-2048);
        result.push({ ...block, content: truncated });
      } else {
        result.push({ ...block, content: sanitized });
      }
      continue;
    }

    // 4. Pi stores the attached output on the assistant tool_use block itself.
    // This is distinct from Claude-style user tool_result blocks and previously
    // bypassed the truncation above, allowing a single 1MB shell result to force
    // immediate context compaction.
    if (block.type === 'tool_use' && typeof block.result === 'string') {
      result.push({ ...block, result: truncateToolUseResult(block.result) });
      continue;
    }

    result.push(block);
  }
  return result;
}

function extractBlobToDisk(base64Data: string, mediaType: string): string | null {
  try {
    if (!fs.existsSync(BLOB_DIR)) {
      fs.mkdirSync(BLOB_DIR, { recursive: true });
    }
    const hash = crypto.createHash('sha256').update(base64Data.slice(0, 1024) + base64Data.length).digest('hex').slice(0, 16);
    const ext = mediaType.includes('pdf') ? '.pdf' : mediaType.includes('png') ? '.png' : '.jpg';
    const filename = `${hash}${ext}`;
    const filePath = path.join(BLOB_DIR, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
    }
    return filename; // relative to BLOB_DIR
  } catch (err) {
    console.error('[msg-store] blob extraction failed:', err);
    return null;
  }
}

export async function saveMessage(
  sessionId: string,
  msg: {
    id: string;
    role: string;
    content: any;
    parentToolUseId?: string | null;
    username?: string | null;
    /**
     * Optional JSON blob for hidden flags / debug / system markers.
     * Known keys:
     *   - hidden: 'server-resume' | 'system-trigger' — frontend skips rendering
     *
     * See: workspace/decisions/2026-05-10-server-resume-prompt-hidden.md
     * Migration: 055_messages_metadata.sql
     */
    metadata?: Record<string, any> | null;
  }
): Promise<void> {
  // Compact content before serializing. Assistant text may include a
  // `tower-artifact` fenced block: normalize it into a structured chat block
  // and materialize the same body to Markdown so the model only writes it once.
  let content = Array.isArray(msg.content) ? compactContent(msg.content) : msg.content;
  if (msg.role === 'assistant' && Array.isArray(content) && hasAssistantArtifactCandidate(content)) {
    content = await materializeAssistantArtifactBlocks(sessionId, normalizeAssistantArtifactBlocks(content));
  }
  const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
  const metadataJson = JSON.stringify(msg.metadata ?? {});

  // short_id — Phase 3 메시지 앵커 (issue #11). (session_id, short_id) composite unique.
  // ON CONFLICT(id) 인 경우(같은 메시지 재호출, 스트리밍 partial update)
  // 기존 short_id 를 그대로 두기 위해 COALESCE 사용 — 새 INSERT 만 short_id 부여 효과.
  // 세션별 unique 라 충돌 거의 0 이지만 안전 위해 최대 5회 retry.
  for (let attempt = 0; attempt < SHORT_ID_MAX_RETRIES; attempt++) {
    const shortId = generateShortCode();
    try {
      await execute(
        `INSERT INTO messages (id, session_id, role, content, parent_tool_use_id, username, metadata, short_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT(id) DO UPDATE SET
           content = EXCLUDED.content,
           parent_tool_use_id = EXCLUDED.parent_tool_use_id,
           username = COALESCE(EXCLUDED.username, messages.username),
           metadata = EXCLUDED.metadata,
           short_id = COALESCE(messages.short_id, EXCLUDED.short_id),
           updated_at = NOW()`,
        [msg.id, sessionId, msg.role, contentStr, msg.parentToolUseId || null, msg.username || null, metadataJson, shortId]
      );
      break;
    } catch (err: any) {
      // (session_id, short_id) composite violation — re-generate and retry
      if (err?.code === PG_UNIQUE_VIOLATION && attempt < SHORT_ID_MAX_RETRIES - 1) {
        continue;
      }
      throw err;
    }
  }

  // A session's activity timestamp follows persisted message activity. Sidebar
  // Latest and project sorting depend on this value; agent wake/send messages are
  // activity too, but they do not change whether the parent session is a Chat.
  await execute(`UPDATE sessions SET updated_at = NOW() WHERE id = $1`, [sessionId]);

  // Engine-agnostic working-set capture: extract workspace/tower absolute
  // paths from assistant messages and feed them to session_file_edits. This
  // catches bash/mcp/external-tool deliverables that per-tool hooks miss.
  // Fire-and-forget; the extractor swallows its own errors.
  // See: workspace/decisions/2026-05-20-session-scoped-file-tabs.md
  //      §"옵션 2 — 응답 텍스트 경로 추출 (engine-agnostic)"
  if (msg.role === 'assistant') {
    try { recordMessagePaths(sessionId, content); }
    catch (err) { console.warn('[msg-store] recordMessagePaths failed:', (err as Error).message); }
    void indexWorkReportMessage({ sessionId, messageId: msg.id, role: msg.role, content })
      .catch((err) => console.warn('[msg-store] indexWorkReportMessage failed:', (err as Error).message));
  }
}

export async function getMessages(sessionId: string): Promise<StoredMessage[]> {
  const order = await hasMessageSeq() ? 'message_seq ASC' : 'created_at ASC, id ASC';
  return await query(
    `SELECT * FROM messages WHERE session_id = $1 ORDER BY ${order}`,
    [sessionId]
  ) as StoredMessage[];
}

/**
 * Paginated message loading: returns the most recent `limit` messages,
 * with optional cursor (`before` message id) for loading older ones.
 * Returns { messages, hasMore, oldestId } for infinite-scroll support.
 */
export async function getMessagesPaginated(
  sessionId: string,
  opts: { limit?: number; before?: string }
): Promise<{ messages: StoredMessage[]; hasMore: boolean; oldestId: string | null }> {
  const limit = Math.min(opts.limit || 100, 500);
  const useMessageSeq = await hasMessageSeq();

  let rows: StoredMessage[];
  if (opts.before) {
    // Load messages older than the cursor
    const cursor = useMessageSeq
      ? await queryOne(
        `SELECT message_seq FROM messages WHERE id = $1 AND session_id = $2`,
        [opts.before, sessionId]
      ) as { message_seq: number } | null
      : await queryOne(
        `SELECT created_at, id FROM messages WHERE id = $1 AND session_id = $2`,
        [opts.before, sessionId]
      ) as { created_at: string; id: string } | null;

    if (!cursor) {
      // Invalid cursor — fall back to latest
      rows = await query(
        `SELECT * FROM messages WHERE session_id = $1 ORDER BY ${useMessageSeq ? 'message_seq DESC' : 'created_at DESC, id DESC'} LIMIT $2`,
        [sessionId, limit + 1]
      ) as StoredMessage[];
    } else if (useMessageSeq) {
      rows = await query(
        `SELECT * FROM messages WHERE session_id = $1 AND message_seq < $2 ORDER BY message_seq DESC LIMIT $3`,
        [sessionId, (cursor as { message_seq: number }).message_seq, limit + 1]
      ) as StoredMessage[];
    } else {
      const legacyCursor = cursor as { created_at: string; id: string };
      rows = await query(
        `SELECT * FROM messages WHERE session_id = $1 AND (created_at, id) < ($2, $3) ORDER BY created_at DESC, id DESC LIMIT $4`,
        [sessionId, legacyCursor.created_at, legacyCursor.id, limit + 1]
      ) as StoredMessage[];
    }
  } else {
    // Initial load — most recent messages
    rows = await query(
      `SELECT * FROM messages WHERE session_id = $1 ORDER BY ${useMessageSeq ? 'message_seq DESC' : 'created_at DESC, id DESC'} LIMIT $2`,
      [sessionId, limit + 1]
    ) as StoredMessage[];
  }

  const hasMore = rows.length > limit;
  if (hasMore) rows = rows.slice(0, limit);

  // Reverse to chronological order (ASC)
  rows.reverse();

  const oldestId = rows.length > 0 ? rows[0].id : null;

  // Pre-parse content strings → objects so the client doesn't need 500× JSON.parse.
  // Older automation/editor bootstrap rows may have been stored as plain text;
  // normalize those to a text block instead of failing the whole /full response.
  const parseContent = (content: any) => {
    if (typeof content !== 'string') return content;
    try {
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed : [{ type: 'text', text: String(parsed) }];
    } catch {
      return [{ type: 'text', text: content }];
    }
  };
  const messages = rows.map(r => ({
    ...r,
    content: parseContent(r.content),
  }));

  return { messages, hasMore, oldestId };
}

export async function updateMessageContent(messageId: string, content: any): Promise<void> {
  let compacted = Array.isArray(content) ? compactContent(content) : content;
  if (Array.isArray(compacted) && hasAssistantArtifactCandidate(compacted)) {
    const row = await queryOne<{ session_id: string; role: string }>(
      `SELECT session_id, role FROM messages WHERE id = $1`,
      [messageId],
    );
    if (row?.role === 'assistant') {
      compacted = await materializeAssistantArtifactBlocks(row.session_id, normalizeAssistantArtifactBlocks(compacted));
    }
  }
  const contentStr = typeof compacted === 'string' ? compacted : JSON.stringify(compacted);
  // `created_at` is an immutable row creation / ordering anchor. Streaming
  // updates only touch `updated_at`; completion is represented separately by
  // `duration_ms` + `completed_at` in updateMessageMetrics().
  // Decision: workspace/decisions/2026-06-08-message-time-lifecycle.md
  await execute(`UPDATE messages SET content = $1, updated_at = NOW() WHERE id = $2`, [contentStr, messageId]);
  void indexWorkReportMessageUpdate(messageId, compacted)
    .catch((err) => console.warn('[msg-store] indexWorkReportMessageUpdate failed:', (err as Error).message));
}

export type AgentTurnCheckpointStatus = 'started' | 'waiting_retry' | 'completed' | 'failed' | 'needs_attention';

/**
 * Persist a non-visible checkpoint on the user message that started an AI turn.
 *
 * This closes a restart gap where the user message was saved, Pi started doing
 * work, but the server restarted before any assistant row had content. On the
 * next boot the transcript looks like "last user message only" unless startup
 * can discover this metadata and resume the orphaned turn.
 */
export async function markAgentTurnCheckpoint(
  messageId: string,
  patch: {
    status: AgentTurnCheckpointStatus;
    sessionId?: string;
    rootTurnId?: string;
    engine?: string;
    model?: string | null;
    engineSessionId?: string | null;
    acceptedAt?: string;
    error?: string | null;
    recoveryToken?: string;
    failureClass?: string;
    assistantMessageId?: string;
    retryDelaySeconds?: number;
    forceNeedsAttention?: boolean;
  }
): Promise<void> {
  if (patch.engine !== 'pi') return;
  const rootTurnId = patch.rootTurnId ?? messageId;
  if (patch.status === 'started' && patch.sessionId) {
    await registerAgentTurn({ rootTurnId, sessionId: patch.sessionId, acceptedAt: patch.acceptedAt });
  } else if (patch.recoveryToken && patch.status !== 'started') {
    await settleAgentTurn({
      rootTurnId,
      token: patch.recoveryToken,
      state: patch.status,
      error: patch.error ?? undefined,
      failureClass: patch.failureClass,
      assistantMessageId: patch.assistantMessageId,
      retryDelaySeconds: patch.retryDelaySeconds,
    });
  } else if (patch.status === 'needs_attention' && patch.forceNeedsAttention) {
    await forceAgentTurnNeedsAttention({
      rootTurnId,
      error: patch.error ?? undefined,
      failureClass: patch.failureClass,
    });
  } else if (patch.status === 'completed' || patch.status === 'failed' || patch.status === 'needs_attention') {
    await updateUnclaimedAgentTurn({
      rootTurnId,
      state: patch.status,
      error: patch.error ?? undefined,
      assistantMessageId: patch.assistantMessageId,
    });
  }
  const payload: Record<string, any> = {
    status: patch.status,
    updated_at: new Date().toISOString(),
  };
  if (patch.sessionId !== undefined) payload.session_id = patch.sessionId;
  payload.root_turn_id = rootTurnId;
  if (patch.engine !== undefined) payload.engine = patch.engine;
  if (patch.model !== undefined) payload.model = patch.model;
  if (patch.engineSessionId !== undefined) payload.engine_session_id = patch.engineSessionId;
  if (patch.error !== undefined) payload.error = patch.error;
  if (patch.status === 'started') payload.started_at = payload.updated_at;
  if (patch.status === 'waiting_retry') payload.retry_at = payload.updated_at;
  if (patch.status === 'completed') payload.completed_at = payload.updated_at;
  if (patch.status === 'failed') payload.failed_at = payload.updated_at;
  if (patch.status === 'needs_attention') payload.needs_attention_at = payload.updated_at;

  await execute(
    `UPDATE messages SET
       metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('agent_turn', COALESCE(metadata->'agent_turn', '{}'::jsonb) || $1::jsonb),
       updated_at = NOW()
     WHERE id = $2`,
    [JSON.stringify(payload), messageId]
  );
}

/** Resolve the latest non-terminal Pi root turn for restart recovery. */
export async function findRecoverableAgentTurnForSession(sessionId: string): Promise<OrphanedAgentTurn | undefined> {
  return await queryOne<OrphanedAgentTurn>(
    `SELECT
       m.session_id,
       m.id AS message_id,
       m.content AS user_message,
       s.engine,
       s.pi_session_file AS engine_session_id,
       m.metadata->'agent_turn' AS checkpoint,
       m.created_at::text AS created_at
     FROM messages m
     JOIN sessions s ON s.id = m.session_id
     LEFT JOIN agent_turns t ON t.root_turn_id = m.id
     WHERE m.session_id = $1
       AND s.engine = 'pi'
       AND m.role = 'user'
       AND COALESCE(t.state, '') NOT IN ('completed', 'failed', 'needs_attention')
       AND COALESCE(t.attempt_count, 0) < 4
       AND (
         COALESCE(m.metadata->'agent_turn'->>'status', '') = 'started'
         OR (t.state = 'waiting_retry' AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= NOW()))
       )
     ORDER BY m.created_at DESC
     LIMIT 1`,
    [sessionId],
  );
}

export type OrphanedAgentTurn = {
  session_id: string;
  message_id: string;
  user_message: string;
  engine: string | null;
  engine_session_id: string | null;
  checkpoint: Record<string, any> | null;
  created_at: string;
};

/** Find recent user turns that started but never reached engine_done. */
export async function findOrphanedStartedAgentTurns(opts: {
  limit?: number;
  minutes?: number;
  excludeSessionIds?: string[];
} = {}): Promise<OrphanedAgentTurn[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const minutes = Math.max(1, Math.min(opts.minutes ?? 360, 1440));
  const excluded = opts.excludeSessionIds ?? [];
  return await query(
    `SELECT
       m.session_id,
       m.id AS message_id,
       m.content AS user_message,
       s.engine,
       s.pi_session_file AS engine_session_id,
       m.metadata->'agent_turn' AS checkpoint,
       m.created_at::text AS created_at
     FROM messages m
     JOIN sessions s ON s.id = m.session_id
     LEFT JOIN agent_turns t ON t.root_turn_id = m.id
     WHERE s.engine = 'pi'
       AND m.role = 'user'
       AND m.created_at > NOW() - ($1::int * INTERVAL '1 minute')
       AND COALESCE(t.state, '') NOT IN ('completed', 'failed', 'needs_attention')
       AND COALESCE(t.attempt_count, 0) < 4
       AND (
         COALESCE(m.metadata->'agent_turn'->>'status', '') = 'started'
         OR (t.state = 'waiting_retry' AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= NOW()))
       )
       AND NOT (t.state = 'running' AND t.owner_token IS NOT NULL AND t.lease_until > NOW())
       AND NOT (m.session_id = ANY($2::text[]))
       AND NOT EXISTS (
         SELECT 1 FROM messages newer_user
          WHERE newer_user.session_id = m.session_id
            AND newer_user.role = 'user'
            AND newer_user.created_at > m.created_at
       )
     ORDER BY m.created_at ASC
     LIMIT $3`,
    [minutes, excluded, limit]
  ) as OrphanedAgentTurn[];
}

/** Attach a tool result to the matching tool_use block in DB */
export async function attachToolResultInDb(sessionId: string, toolUseId: string, result: string): Promise<void> {
  // Find assistant messages in this session that contain this tool_use_id
  const rows = await query(
    `SELECT id, content FROM messages WHERE session_id = $1 AND role = 'assistant' ORDER BY created_at DESC`,
    [sessionId]
  ) as { id: string; content: string }[];

  for (const row of rows) {
    try {
      const content = JSON.parse(row.content);
      let found = false;
      for (const block of content) {
        if (block.type === 'tool_use' && (block.id === toolUseId || block.toolUse?.id === toolUseId)) {
          if (block.toolUse) {
            block.toolUse.result = result;
          } else {
            block.result = result;
          }
          found = true;
          break;
        }
      }
      if (found) {
        await execute(`UPDATE messages SET content = $1, updated_at = NOW() WHERE id = $2`, [JSON.stringify(content), row.id]);
        return;
      }
    } catch {}
  }
}

export async function touchMessages(messageIds: string[]): Promise<void> {
  const ids = [...new Set(messageIds.filter(Boolean))];
  if (ids.length === 0) return;

  // `created_at` is immutable. This helper is only a lightweight activity touch
  // for messages included in a terminal turn_done event; it must not affect
  // chronological ordering or reload-visible message timestamps.
  await execute(
    `UPDATE messages
        SET updated_at = NOW()
      WHERE id = ANY($1::text[])`,
    [ids],
  );
}

export async function updateMessageMetrics(
  messageId: string,
  metrics: {
    duration_ms?: number;
    /** Finalize completed_at only for the terminal root-turn metrics update. */
    finalize_completed_at?: boolean;
    input_tokens?: number;
    output_tokens?: number;
    /** Claude prompt cache read tokens (persisted to metadata.usage.cache_read_tokens) */
    cache_read_tokens?: number;
    /** Claude prompt cache creation tokens (persisted to metadata.usage.cache_creation_tokens) */
    cache_creation_tokens?: number;
    /** Provider-reported hidden reasoning tokens (persisted to metadata.usage.reasoning_tokens) */
    reasoning_tokens?: number;
    /** Claude prompt cache creation 1h TTL breakdown (SDK 0.2.112+) */
    cache_creation_1h_tokens?: number;
    /** Claude prompt cache creation 5m TTL breakdown (SDK 0.2.112+) */
    cache_creation_5m_tokens?: number;
    /** Provider-reported cost in USD (Pi SDK usage.cost.total) */
    cost_usd?: number;
    /** Provider-reported actual input-side context for the user-facing CTX footer. */
    context_input_tokens?: number;
    /** Model context window used for context_input_tokens. */
    context_window_size?: number;
    /** Internal conservative context/risk estimate; not the user-facing actual CTX. */
    context_estimated_tokens?: number;
    /** Outgoing request/body estimate used for preflight diagnostics. */
    next_request_estimated_tokens?: number;
    /** Operational threshold at which Tower/Pi should compact. */
    compact_threshold_tokens?: number;
    /** Shadow-only context contract; not yet consumed by user-facing CTX. */
    context_snapshot?: {
      actualTokens?: number;
      requestTokens?: number;
      estimatedTokens?: number;
      windowTokens: number;
      actualSource: 'provider' | 'cache-reconstructed' | 'none';
      requestSource: 'sanitized-request' | 'none';
      capturedAt: string;
      terminal: boolean;
    };
  }
): Promise<void> {
  // Tokens & duration go to dedicated columns; provider-specific usage
  // breakdown (cache + cost) stays in metadata.usage as JSONB (no migration
  // needed). Merge into existing metadata so we don't clobber other keys
  // (e.g. debug flags from mig 055).
  const cacheRead = metrics.cache_read_tokens ?? null;
  const cacheCreation = metrics.cache_creation_tokens ?? null;
  const reasoningTokens = metrics.reasoning_tokens ?? null;
  const cacheCreation1h = metrics.cache_creation_1h_tokens ?? null;
  const cacheCreation5m = metrics.cache_creation_5m_tokens ?? null;
  const costUsd = metrics.cost_usd ?? null;
  const contextInput = metrics.context_input_tokens ?? null;
  const contextWindow = metrics.context_window_size ?? null;
  const contextEstimated = metrics.context_estimated_tokens ?? null;
  const nextRequestEstimated = metrics.next_request_estimated_tokens ?? null;
  const compactThreshold = metrics.compact_threshold_tokens ?? null;
  const contextSnapshot = metrics.context_snapshot ?? null;
  const hasUsageMetadata = cacheRead !== null || cacheCreation !== null || reasoningTokens !== null || costUsd !== null || contextInput !== null || contextWindow !== null || contextEstimated !== null || nextRequestEstimated !== null || compactThreshold !== null || contextSnapshot !== null;

  if (hasUsageMetadata) {
    await execute(
      `UPDATE messages SET
         duration_ms = $1,
         input_tokens = $2,
         output_tokens = $3,
         updated_at = NOW(),
         completed_at = CASE
           WHEN $16::boolean THEN NOW()
           ELSE completed_at
         END,
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'usage', jsonb_build_object(
             'cache_read_tokens', $4::bigint,
             'cache_creation_tokens', $5::bigint,
             'reasoning_tokens', $6::bigint,
             'cache_creation_1h_tokens', $7::bigint,
             'cache_creation_5m_tokens', $8::bigint,
             'cost_usd', $9::numeric,
             'context_input_tokens', $10::bigint,
             'context_window_size', $11::bigint,
             'context_estimated_tokens', $12::bigint,
             'next_request_estimated_tokens', $13::bigint,
             'compact_threshold_tokens', $14::bigint
           ) || CASE
             WHEN $15::jsonb IS NOT NULL THEN jsonb_build_object('context_snapshot', $15::jsonb)
             ELSE '{}'::jsonb
           END
         )
       WHERE id = $17`,
      [
        metrics.duration_ms ?? null,
        metrics.input_tokens ?? null,
        metrics.output_tokens ?? null,
        cacheRead,
        cacheCreation,
        reasoningTokens,
        cacheCreation1h,
        cacheCreation5m,
        costUsd,
        contextInput,
        contextWindow,
        contextEstimated,
        nextRequestEstimated,
        compactThreshold,
        contextSnapshot ? JSON.stringify(contextSnapshot) : null,
        metrics.finalize_completed_at === true,
        messageId,
      ]
    );
  } else {
    await execute(
      `UPDATE messages SET
         duration_ms = $1,
         input_tokens = $2,
         output_tokens = $3,
         updated_at = NOW(),
         completed_at = CASE
           WHEN $4::boolean THEN NOW()
           ELSE completed_at
         END
       WHERE id = $5`,
      [
        metrics.duration_ms ?? null,
        metrics.input_tokens ?? null,
        metrics.output_tokens ?? null,
        metrics.finalize_completed_at === true,
        messageId,
      ]
    );
  }
}

/**
 * Mark a message as having triggered SDK autoCompact. Persists:
 *   metadata.compact_boundary_at        = ISO timestamp (now)
 *   metadata.compact_preserved_segment  = boolean from SDK (if present)
 *
 * Uses jsonb || merge so existing keys (usage breakdown, hidden flags from
 * migration 055) are preserved. Idempotent — re-marking just refreshes
 * the timestamp.
 *
 * Counting query:
 *   SELECT date_trunc('day', created_at), count(*)
 *   FROM messages WHERE metadata ? 'compact_boundary_at' GROUP BY 1;
 */
export async function markCompactBoundary(
  messageId: string,
  meta: { preservedSegment?: boolean }
): Promise<void> {
  await execute(
    `UPDATE messages SET
       updated_at = NOW(),
       metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
         'compact_boundary_at', to_jsonb(NOW()::text),
         'compact_preserved_segment', to_jsonb($1::boolean)
       )
     WHERE id = $2`,
    [meta.preservedSegment ?? false, messageId]
  );
}

export async function deleteMessages(sessionId: string): Promise<void> {
  await execute(`DELETE FROM messages WHERE session_id = $1`, [sessionId]);
}

export async function deleteMessage(sessionId: string, messageId: string): Promise<boolean> {
  const result = await execute(`DELETE FROM messages WHERE session_id = $1 AND id = $2`, [sessionId, messageId]);
  return result.changes > 0;
}

/**
 * Backfill short_id for messages created before migration 069 (issue #11 Phase 3).
 *
 * Batched UPDATE — 27만+ rows 라 한 번에 들면 dev backend 부팅이 길어진다.
 * 500-row batch, fire-and-forget from backend/index.ts startup. (session_id, short_id)
 * composite unique 라 globally 충돌 risk 무시 가능.
 *
 * 반환: 업데이트한 행 수.
 */
export async function backfillMessageShortIds(batchSize: number = 500): Promise<number> {
  let totalUpdated = 0;
  while (true) {
    const rows = await query<{ id: string }>(
      'SELECT id FROM messages WHERE short_id IS NULL LIMIT $1',
      [batchSize],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      for (let attempt = 0; attempt < SHORT_ID_MAX_RETRIES; attempt++) {
        const code = generateShortCode();
        try {
          await execute(
            'UPDATE messages SET short_id = $1 WHERE id = $2 AND short_id IS NULL',
            [code, row.id],
          );
          totalUpdated++;
          break;
        } catch (err: any) {
          if (err?.code === PG_UNIQUE_VIOLATION && attempt < SHORT_ID_MAX_RETRIES - 1) {
            continue;
          }
          // 다른 에러는 로그만, 다음 row 진행
          console.warn(`[msg-store] backfillShortIds: row ${row.id} failed:`, err?.message);
          break;
        }
      }
    }
  }
  return totalUpdated;
}
