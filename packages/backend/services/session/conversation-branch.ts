import { execute, query, queryOne, transaction, withClient } from '../../db/pg-repo.js';
import { getAllRunningSessionIds } from '../../engines/index.js';
import { rehydratePiSessionFromMessages } from '../../engines/pi/rehydrate.js';
import type { RehydrateInputMessage } from '../../engines/types.js';
import { extractTextFromContent } from '../../utils/text.js';
import { createSession, getSession } from './session-manager.js';

export type ConversationBranchMode = 'edit_and_resend' | 'clone_through';

export interface ConversationBranchResult {
  session: Awaited<ReturnType<typeof getSession>>;
  mode: ConversationBranchMode;
  draft: string;
  replayPrompt: string;
  sourceSessionId: string;
  sourceMessageId: string;
  copiedMessageCount: number;
}

export interface ConversationRewindResult {
  session: Awaited<ReturnType<typeof getSession>>;
  replayPrompt: string;
  sourceSessionId: string;
  sourceMessageId: string;
  supersededMessageCount: number;
}

function toRehydrateMessages(rows: any[]): RehydrateInputMessage[] {
  return rows.flatMap((row) => {
    try {
      const content = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
      return Array.isArray(content) ? [{ id: row.id, role: row.role, content, timestamp: new Date(row.created_at).getTime() }] : [];
    } catch { return []; }
  });
}

export async function branchConversation(input: {
  sourceSessionId: string;
  sourceMessageId: string;
  actorUserId: number;
  mode: ConversationBranchMode;
}): Promise<ConversationBranchResult> {
  const source = await queryOne<any>('SELECT * FROM sessions WHERE id = $1', [input.sourceSessionId]);
  if (!source) throw Object.assign(new Error('conversation_branch_source_not_found'), { status: 404 });
  if (getAllRunningSessionIds().includes(input.sourceSessionId)) {
    throw Object.assign(new Error('conversation_branch_source_in_progress'), { status: 409 });
  }
  const target = await queryOne<any>(
    `SELECT id, role, content, message_seq FROM messages
      WHERE id = $1 AND session_id = $2
        AND COALESCE(metadata->>'contextState', 'active') = 'active'`,
    [input.sourceMessageId, input.sourceSessionId],
  );
  if (!target) throw Object.assign(new Error('conversation_branch_message_not_found'), { status: 404 });
  if (target.role !== 'user') {
    throw Object.assign(new Error('conversation_branch_requires_user_message'), { status: 400 });
  }

  const targetPrompt = extractTextFromContent(target.content).trim();
  const draft = input.mode === 'edit_and_resend' ? targetPrompt : '';
  const replayPrompt = input.mode === 'clone_through' ? targetPrompt : '';
  if (!targetPrompt) {
    throw Object.assign(new Error('conversation_branch_user_message_empty'), { status: 400 });
  }

  const child = await createSession(
    `${source.name} (과거에서 다시 시작)`, source.cwd, input.actorUserId, source.project_id,
    source.engine, null, input.sourceMessageId, input.sourceSessionId, 'conversation_branch', source.model_used,
    { visibility: source.visibility === 'project' ? 'project' : 'private' },
  );

  const boundary = `message_seq < $3`;
  const copy = await execute(
    `INSERT INTO messages (id, session_id, role, content, parent_tool_use_id,
                           duration_ms, input_tokens, output_tokens, created_at, username, metadata, message_seq)
     SELECT gen_random_uuid()::text, $1, role, content, parent_tool_use_id,
            duration_ms, input_tokens, output_tokens, created_at, username, metadata, message_seq
       FROM messages
      WHERE session_id = $2 AND ${boundary}
        AND COALESCE(metadata->>'contextState', 'active') = 'active'
      ORDER BY message_seq ASC`,
    [child.id, input.sourceSessionId, target.message_seq],
  );

  await execute(
    `INSERT INTO session_runtime_snapshots (
       session_id, project_id, harness_id, harness_version, runtime_profile_id,
       runtime_profile_version, engine, snapshot, snapshot_hash, source, pinned_at, prompt_bundle_hash
     )
     SELECT $1, project_id, harness_id, harness_version, runtime_profile_id,
            runtime_profile_version, engine, snapshot, snapshot_hash, 'conversation_branch', now(), prompt_bundle_hash
       FROM session_runtime_snapshots WHERE session_id = $2
     ON CONFLICT (session_id) DO NOTHING`,
    [child.id, input.sourceSessionId],
  );

  if ((source.engine || 'pi') === 'pi' && copy.changes > 0) {
    try {
      const rows = await query<any>(
        `SELECT id, role, content, created_at FROM messages
          WHERE session_id = $1 AND role IN ('user', 'assistant')
            AND COALESCE(metadata->>'contextState', 'active') = 'active'
          ORDER BY message_seq ASC`, [child.id],
      );
      const messages = toRehydrateMessages(rows);
      if (messages.length) {
        const piSessionFile = await rehydratePiSessionFromMessages(child.id, messages, source.cwd);
        await execute('UPDATE sessions SET pi_session_file = $1 WHERE id = $2', [piSessionFile, child.id]);
      }
    } catch (error) {
      console.warn('[conversation-branch] Pi prefix rehydrate failed; DB prefix remains usable:', error);
    }
  }

  return {
    session: await getSession(child.id), mode: input.mode, draft, replayPrompt,
    sourceSessionId: input.sourceSessionId, sourceMessageId: input.sourceMessageId,
    copiedMessageCount: copy.changes,
  };
}


export async function rewindConversationForReplay(input: {
  sourceSessionId: string;
  sourceMessageId: string;
}): Promise<ConversationRewindResult> {
  const source = await queryOne<any>('SELECT * FROM sessions WHERE id = $1', [input.sourceSessionId]);
  if (!source) throw Object.assign(new Error('conversation_rewind_source_not_found'), { status: 404 });
  if (getAllRunningSessionIds().includes(input.sourceSessionId)) {
    throw Object.assign(new Error('conversation_rewind_source_in_progress'), { status: 409 });
  }
  if ((source.engine || 'pi') !== 'pi') {
    throw Object.assign(new Error('conversation_rewind_requires_pi_session'), { status: 409 });
  }

  const target = await queryOne<any>(
    `SELECT id, role, content, message_seq FROM messages
      WHERE id = $1 AND session_id = $2
        AND COALESCE(metadata->>'contextState', 'active') = 'active'`,
    [input.sourceMessageId, input.sourceSessionId],
  );
  if (!target) throw Object.assign(new Error('conversation_rewind_message_not_found'), { status: 404 });
  if (target.role !== 'user') {
    throw Object.assign(new Error('conversation_rewind_requires_user_message'), { status: 400 });
  }

  const replayPrompt = extractTextFromContent(target.content).trim();
  if (!replayPrompt) {
    throw Object.assign(new Error('conversation_rewind_user_message_empty'), { status: 400 });
  }

  const prefixRows = await query<any>(
    `SELECT id, role, content, created_at FROM messages
      WHERE session_id = $1 AND role IN ('user', 'assistant') AND message_seq < $2
        AND COALESCE(metadata->>'contextState', 'active') = 'active'
      ORDER BY message_seq ASC`,
    [input.sourceSessionId, target.message_seq],
  );
  const piSessionFile = await rehydratePiSessionFromMessages(input.sourceSessionId, toRehydrateMessages(prefixRows), source.cwd);
  const superseded = await transaction(async (client) => {
    const db = withClient(client);
    const lockedSource = await db.queryOne<{ id: string }>(
      `SELECT id FROM sessions WHERE id = $1 FOR UPDATE`,
      [input.sourceSessionId],
    );
    if (!lockedSource) throw Object.assign(new Error('conversation_rewind_source_not_found'), { status: 404 });
    const lockedTarget = await db.queryOne<{ id: string; role: string; message_seq: number }>(
      `SELECT id, role, message_seq FROM messages
        WHERE id = $1 AND session_id = $2
          AND COALESCE(metadata->>'contextState', 'active') = 'active'
        FOR UPDATE`,
      [input.sourceMessageId, input.sourceSessionId],
    );
    if (!lockedTarget) throw Object.assign(new Error('conversation_rewind_message_not_found'), { status: 404 });
    if (lockedTarget.role !== 'user') {
      throw Object.assign(new Error('conversation_rewind_requires_user_message'), { status: 400 });
    }
    if (String(lockedTarget.message_seq) !== String(target.message_seq)) {
      throw Object.assign(new Error('conversation_rewind_message_seq_changed'), { status: 409 });
    }
    const supersedeResult = await db.execute(
      `UPDATE messages
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'contextState', 'superseded',
                'supersededByRewindAt', NOW()::text,
                'supersededFromMessageId', $3::text
              ),
              updated_at = NOW()
        WHERE session_id = $1 AND message_seq >= $2
          AND COALESCE(metadata->>'contextState', 'active') <> 'superseded'`,
      [input.sourceSessionId, target.message_seq, input.sourceMessageId],
    );
    await db.execute(
      `UPDATE sessions SET pi_session_file = $1, updated_at = NOW() WHERE id = $2`,
      [piSessionFile, input.sourceSessionId],
    );
    return supersedeResult;
  });

  return {
    session: await getSession(input.sourceSessionId), replayPrompt,
    sourceSessionId: input.sourceSessionId, sourceMessageId: input.sourceMessageId,
    supersededMessageCount: superseded.changes,
  };
}
