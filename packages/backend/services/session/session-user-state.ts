import { execute, queryOne, transaction, withClient } from '../../db/pg-repo.js';

export type SessionSubscriptionState = 'subscribed' | 'muted';

export interface SessionUserState {
  userId: number;
  sessionId: string;
  participatedAt: string | null;
  subscriptionState: SessionSubscriptionState;
  subscribedFromSequence: number;
  lastReadAiSequence: number;
  lastFinalAiSequence: number;
  unreadAiResponse: boolean;
  updatedAt: string;
}

type StateRow = {
  user_id: number | string;
  session_id: string;
  participated_at: Date | string | null;
  subscription_state: SessionSubscriptionState;
  subscribed_from_sequence: number | string;
  last_read_ai_sequence: number | string;
  last_final_ai_sequence: number | string;
  updated_at: Date | string;
};

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapState(row: StateRow): SessionUserState {
  const subscribedFromSequence = Number(row.subscribed_from_sequence);
  const lastReadAiSequence = Number(row.last_read_ai_sequence);
  const lastFinalAiSequence = Number(row.last_final_ai_sequence);
  return {
    userId: Number(row.user_id),
    sessionId: row.session_id,
    participatedAt: iso(row.participated_at),
    subscriptionState: row.subscription_state,
    subscribedFromSequence,
    lastReadAiSequence,
    lastFinalAiSequence,
    unreadAiResponse: row.subscription_state === 'subscribed'
      && lastFinalAiSequence > Math.max(subscribedFromSequence, lastReadAiSequence),
    updatedAt: iso(row.updated_at)!,
  };
}

/** Return state only when the Session still exists. Access checks belong to the API boundary. */
export async function getSessionUserState(userId: number, sessionId: string): Promise<SessionUserState | null> {
  const row = await queryOne<StateRow>(
    `SELECT sus.*, s.last_final_ai_sequence
       FROM session_user_states sus
       JOIN sessions s ON s.id = sus.session_id
      WHERE sus.user_id = $1 AND sus.session_id = $2`,
    [userId, sessionId],
  );
  return row ? mapState(row) : null;
}

/**
 * Creation or a real human message means the user is participating and waiting
 * for the next AI result. Re-subscription starts at the current sequence, so
 * historical completions never become unread retroactively.
 */
export async function subscribeSessionParticipant(userId: number, sessionId: string): Promise<void> {
  await execute(
    `INSERT INTO session_user_states (
       user_id, session_id, participated_at, subscription_state,
       subscribed_from_sequence, last_read_ai_sequence, updated_at
     )
     SELECT $1, s.id, NOW(), 'subscribed', s.last_final_ai_sequence,
            s.last_final_ai_sequence, NOW()
       FROM sessions s
      WHERE s.id = $2
     ON CONFLICT (user_id, session_id)
     DO UPDATE SET participated_at = COALESCE(session_user_states.participated_at, NOW()),
                   subscription_state = 'subscribed',
                   subscribed_from_sequence = CASE
                     WHEN session_user_states.subscription_state = 'muted'
                       THEN GREATEST(session_user_states.subscribed_from_sequence, EXCLUDED.subscribed_from_sequence)
                     ELSE session_user_states.subscribed_from_sequence
                   END,
                   last_read_ai_sequence = CASE
                     WHEN session_user_states.subscription_state = 'muted'
                       THEN GREATEST(session_user_states.last_read_ai_sequence, EXCLUDED.last_read_ai_sequence)
                     ELSE session_user_states.last_read_ai_sequence
                   END,
                   updated_at = NOW()`,
    [userId, sessionId],
  );
}

/** Resolve a persisted human username before recording participation. */
export async function subscribeSessionParticipantByUsername(
  username: string | null | undefined,
  sessionId: string,
): Promise<void> {
  const normalized = username?.trim();
  if (!normalized) return;
  const user = await queryOne<{ id: number }>(
    `SELECT id FROM users WHERE username = $1 AND COALESCE(disabled, 0) = 0`,
    [normalized],
  );
  if (user) await subscribeSessionParticipant(user.id, sessionId);
}

/**
 * Persist one completed root turn and increment the Session sequence exactly
 * once. The transaction serializes sequence assignment on the Session row.
 */
export async function recordCompletedAiTurn(input: {
  sessionId: string;
  rootTurnId: string;
  assistantMessageId: string;
  completedAt?: string;
}): Promise<number | null> {
  if (!input.sessionId || !input.rootTurnId || !input.assistantMessageId) return null;
  return transaction(async client => {
    const db = withClient(client);
    const session = await db.queryOne<{ last_final_ai_sequence: number | string }>(
      `SELECT last_final_ai_sequence FROM sessions WHERE id = $1 FOR UPDATE`,
      [input.sessionId],
    );
    if (!session) return null;

    const existing = await db.queryOne<{ ai_sequence: number | string }>(
      `SELECT ai_sequence
         FROM session_ai_turn_completions
        WHERE session_id = $1 AND root_turn_id = $2`,
      [input.sessionId, input.rootTurnId],
    );
    if (existing) return Number(existing.ai_sequence);

    const nextSequence = Number(session.last_final_ai_sequence) + 1;
    const inserted = await db.queryOne<{ ai_sequence: number | string }>(
      `INSERT INTO session_ai_turn_completions (
         session_id, root_turn_id, assistant_message_id, ai_sequence, completed_at
       )
       SELECT $1, $2, m.id, $4, COALESCE($5::timestamptz, NOW())
         FROM messages m
        WHERE m.id = $3 AND m.session_id = $1 AND m.role = 'assistant'
       ON CONFLICT (session_id, root_turn_id) DO NOTHING
       RETURNING ai_sequence`,
      [input.sessionId, input.rootTurnId, input.assistantMessageId, nextSequence, input.completedAt || null],
    );
    if (!inserted) {
      const raced = await db.queryOne<{ ai_sequence: number | string }>(
        `SELECT ai_sequence FROM session_ai_turn_completions
          WHERE session_id = $1 AND root_turn_id = $2`,
        [input.sessionId, input.rootTurnId],
      );
      return raced ? Number(raced.ai_sequence) : null;
    }

    await db.execute(
      `UPDATE sessions SET last_final_ai_sequence = $2 WHERE id = $1`,
      [input.sessionId, Number(inserted.ai_sequence)],
    );
    return Number(inserted.ai_sequence);
  });
}

/** Manual subscribe/mute does not alter participation history. */
export async function setSessionSubscription(
  userId: number,
  sessionId: string,
  subscribed: boolean,
): Promise<void> {
  await execute(
    `INSERT INTO session_user_states (
       user_id, session_id, subscription_state,
       subscribed_from_sequence, last_read_ai_sequence, updated_at
     )
     SELECT $1, s.id, $3, s.last_final_ai_sequence, s.last_final_ai_sequence, NOW()
       FROM sessions s
      WHERE s.id = $2
     ON CONFLICT (user_id, session_id)
     DO UPDATE SET subscription_state = EXCLUDED.subscription_state,
                   subscribed_from_sequence = CASE
                     WHEN EXCLUDED.subscription_state = 'subscribed'
                       THEN GREATEST(session_user_states.subscribed_from_sequence, EXCLUDED.subscribed_from_sequence)
                     ELSE session_user_states.subscribed_from_sequence
                   END,
                   last_read_ai_sequence = CASE
                     WHEN EXCLUDED.subscription_state = 'subscribed'
                       THEN GREATEST(session_user_states.last_read_ai_sequence, EXCLUDED.last_read_ai_sequence)
                     ELSE session_user_states.last_read_ai_sequence
                   END,
                   updated_at = NOW()`,
    [userId, sessionId, subscribed ? 'subscribed' : 'muted'],
  );
}

/** Read cursors are clamped to the server sequence and can only move forward. */
export async function markAiResponseRead(
  userId: number,
  sessionId: string,
  requestedSequence: number,
): Promise<void> {
  const sequence = Number.isSafeInteger(requestedSequence) && requestedSequence >= 0
    ? requestedSequence
    : 0;
  await execute(
    `UPDATE session_user_states sus
        SET last_read_ai_sequence = GREATEST(
              sus.last_read_ai_sequence,
              LEAST($3::bigint, s.last_final_ai_sequence)
            ),
            updated_at = NOW()
       FROM sessions s
      WHERE sus.user_id = $1
        AND sus.session_id = $2
        AND s.id = sus.session_id`,
    [userId, sessionId, sequence],
  );
}
