/** Atomic direct voice commit. Caller holds the shared Session admission mutex.
 * No upsert: UUID collision/duplicate is a rollback, never overwrite another message.
 */
import { randomUUID } from 'node:crypto';
import { transaction } from '../../db/pg-repo.js';
import { generateShortCode } from '../session/short-code.js';
import { humanChatMetadata } from '../session/agent-session/classification.js';
import type { FastVoiceIdentity } from './voice-fast-router.js';
export async function commitVoiceFastDirect(input: FastVoiceIdentity & {
  transcript: string; answer: string; username: string; model: string; signal: AbortSignal;
}): Promise<{ assistantMessageId: string }> {
  const assistantMessageId = randomUUID();
  await transaction(async (client) => {
    input.signal.throwIfAborted();
    const session = await client.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [input.sessionId]);
    if (!session.rows.length) throw new Error('VOICE_SESSION_NOT_FOUND');
    const active = await client.query("SELECT root_turn_id FROM agent_turns WHERE session_id = $1 AND state IN ('running','waiting_retry','stop_requested') LIMIT 1", [input.sessionId]);
    if (active.rows.length) throw new Error('VOICE_BUSY');
    const metadata = JSON.stringify({ sourceType: 'voice_fast_direct', voiceSessionId: input.voiceSessionId,
      rootTurnId: input.turnId, revision: input.revision, model: input.model, generated: true });
    await client.query(`INSERT INTO messages (id,session_id,role,content,username,metadata,short_id,updated_at)
      VALUES ($1,$2,'user',$3,$4,$5,$6,NOW())`,
    [input.turnId, input.sessionId, JSON.stringify([{ type: 'text', text: input.transcript }]), input.username, JSON.stringify({ ...JSON.parse(metadata), ...humanChatMetadata(), responseMode: 'voice_fast_direct' }), generateShortCode()]);
    await client.query(`INSERT INTO messages (id,session_id,role,content,metadata,short_id,updated_at)
      VALUES ($1,$2,'assistant',$3,$4,$5,NOW())`,
    [assistantMessageId, input.sessionId, JSON.stringify([{ type: 'text', text: input.answer }]), metadata, generateShortCode()]);
    await client.query(`INSERT INTO agent_turns (root_turn_id,session_id,state,assistant_message_id,accepted_at,execution_started_at,terminal_at,completed_at)
      VALUES ($1,$2,'completed',$3,NOW(),NOW(),NOW(),NOW())`, [input.turnId, input.sessionId, assistantMessageId]);
    await client.query('UPDATE sessions SET turn_count = COALESCE(turn_count,0)+1, updated_at = NOW() WHERE id = $1', [input.sessionId]);
    input.signal.throwIfAborted(); // transaction wrapper rolls back on observed cancellation before COMMIT
  });
  return { assistantMessageId };
}
