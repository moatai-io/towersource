// Owns: the small durable state machine for one root user turn.
// Public API: registerAgentTurn, claimAgentTurn, settleAgentTurn. See README.md.

import { query, queryOne } from '../../db/pg-repo.js';
import { projectRecoveryAttention } from './recovery-attention.js';

export type AgentTurnState = 'running' | 'stop_requested' | 'waiting_retry' | 'completed' | 'stopped_clean' | 'stopped_forced' | 'failed' | 'needs_attention';

export type AgentTurnClaim = {
  claimed: boolean;
  token?: string;
  attempt: number;
  state: AgentTurnState | 'missing';
};

export type ForegroundAgentTurnClaim = {
  claimed: boolean;
  token?: string;
  state: AgentTurnState | 'missing';
};

export type AgentTurnTiming = {
  rootTurnId: string;
  state: AgentTurnState;
  acceptedAt: string;
  executionStartedAt: string | null;
  waitingUserStartedAt: string | null;
  waitingUserMs: number;
  terminalAt: string | null;
  lastError: string | null;
  requiresAttention: boolean;
  recoveryDisposition: 'superseded' | null;
};

export type DueAgentTurnRetry = {
  rootTurnId: string;
  sessionId: string;
  engineSessionId: string | null;
  acceptedAt: string;
};

/** Ensure the root turn has one durable workflow row without resetting an existing state. */
export async function registerAgentTurn(params: {
  rootTurnId: string;
  sessionId: string;
  acceptedAt?: string;
}): Promise<void> {
  await queryOne(
    `INSERT INTO agent_turns (root_turn_id, session_id, state, accepted_at, execution_started_at)
     VALUES ($1, $2, 'running', COALESCE($3::timestamptz, NOW()), NOW())
     ON CONFLICT (root_turn_id) DO NOTHING
     RETURNING root_turn_id`,
    [params.rootTurnId, params.sessionId, params.acceptedAt ?? null],
  );
}

/** Return the latest active durable timing snapshot for reconnect/restart recovery. */
export async function getActiveAgentTurnTiming(sessionId: string): Promise<AgentTurnTiming | null> {
  const row = await queryOne<{
    root_turn_id: string;
    state: AgentTurnState;
    accepted_at: string;
    execution_started_at: string | null;
    waiting_user_started_at: string | null;
    waiting_user_ms: string | number;
    terminal_at: string | null;
    last_error: string | null;
    last_failure_class: string | null;
  }>(
    `SELECT root_turn_id, state, accepted_at::text, execution_started_at::text,
            waiting_user_started_at::text, waiting_user_ms, terminal_at::text, last_error, last_failure_class
       FROM agent_turns
      WHERE session_id = $1
      ORDER BY accepted_at DESC
      LIMIT 1`,
    [sessionId],
  );
  if (!row) return null;
  return {
    rootTurnId: row.root_turn_id,
    ...projectRecoveryAttention(row.state, row.last_failure_class, row.last_error),
    acceptedAt: row.accepted_at,
    executionStartedAt: row.execution_started_at,
    waitingUserStartedAt: row.waiting_user_started_at,
    waitingUserMs: Number(row.waiting_user_ms || 0),
    terminalAt: row.terminal_at,
  };
}

/**
 * Fail closed for AUQ waits whose in-memory resolver disappeared with a backend restart.
 * The suspended engine Promise cannot be reconstructed safely, so the turn must not
 * be auto-resumed as ordinary work without the user's required answer.
 */
export async function interruptRestartedWaitingUserTurns(): Promise<Array<{ rootTurnId: string; sessionId: string }>> {
  const rows = await query<{ root_turn_id: string; session_id: string }>(
    `UPDATE agent_turns
        SET state = 'needs_attention',
            owner_token = NULL,
            owner_boot_id = NULL,
            lease_until = NULL,
            next_attempt_at = NULL,
            last_failure_class = 'ask_user_restart_interrupted',
            last_error = 'The server restarted while waiting for your answer. Please send your answer again to continue.',
            terminal_at = NOW(),
            waiting_user_ms = waiting_user_ms + GREATEST(
              0,
              FLOOR(EXTRACT(EPOCH FROM (NOW() - waiting_user_started_at)) * 1000)::bigint
            ),
            waiting_user_started_at = NULL,
            updated_at = NOW()
      WHERE waiting_user_started_at IS NOT NULL
        AND state NOT IN ('completed', 'failed', 'needs_attention')
      RETURNING root_turn_id, session_id`,
  );
  return rows.map((row) => ({ rootTurnId: row.root_turn_id, sessionId: row.session_id }));
}

/**
 * Fail closed for restart-recovery candidates that are too old or no longer the
 * latest human turn in their session. Replaying either kind can execute stale
 * tools and makes inactive sessions look newly active.
 */
export async function expireUnsafeRestartRecoveryTurns(params: {
  maxAgeHours?: number;
} = {}): Promise<Array<{ rootTurnId: string; sessionId: string; reason: 'stale' | 'superseded' }>> {
  const maxAgeHours = Math.max(1, Math.min(params.maxAgeHours ?? 24, 168));
  const rows = await query<{ root_turn_id: string; session_id: string; reason: 'stale' | 'superseded' }>(
    `WITH candidates AS (
       SELECT t.root_turn_id,
              t.session_id,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM messages newer_user
                   WHERE newer_user.session_id = t.session_id
                     AND newer_user.role = 'user'
                     AND newer_user.id <> t.root_turn_id
                     AND newer_user.created_at > COALESCE(t.accepted_at, t.created_at)
                ) THEN 'superseded'
                ELSE 'stale'
              END AS reason
         FROM agent_turns t
        WHERE t.state IN ('running', 'waiting_retry', 'stop_requested')
          AND t.waiting_user_started_at IS NULL
        AND COALESCE(t.last_failure_class,'') <> 'wait_requested'
          AND (
            COALESCE(t.accepted_at, t.created_at) < NOW() - ($1::int * INTERVAL '1 hour')
            OR EXISTS (
              SELECT 1 FROM messages newer_user
               WHERE newer_user.session_id = t.session_id
                 AND newer_user.role = 'user'
                 AND newer_user.id <> t.root_turn_id
                 AND newer_user.created_at > COALESCE(t.accepted_at, t.created_at)
            )
          )
     ), changed AS (
       UPDATE agent_turns t
          SET state = 'needs_attention',
              owner_token = NULL,
              owner_boot_id = NULL,
              lease_until = NULL,
              next_attempt_at = NULL,
              last_failure_class = CASE candidates.reason
                WHEN 'superseded' THEN 'restart_recovery_superseded'
                ELSE 'restart_recovery_stale'
              END,
              last_error = CASE candidates.reason
                WHEN 'superseded' THEN 'Automatic recovery skipped because a newer user turn exists in this session.'
                ELSE 'Automatic recovery skipped because this turn has been inactive for more than 24 hours.'
              END,
              terminal_at = NOW(),
              updated_at = NOW()
         FROM candidates
        WHERE t.root_turn_id = candidates.root_turn_id
        RETURNING t.root_turn_id, t.session_id, candidates.reason
     )
     SELECT root_turn_id, session_id, reason FROM changed`,
    [maxAgeHours],
  );
  return rows.map((row) => ({ rootTurnId: row.root_turn_id, sessionId: row.session_id, reason: row.reason }));
}

/** Start or stop human-input waiting while accumulating prior wait segments. */
export async function setAgentTurnWaitingUser(rootTurnId: string, waiting: boolean): Promise<void> {
  await queryOne(
    waiting
      ? `UPDATE agent_turns
            SET waiting_user_started_at = COALESCE(waiting_user_started_at, NOW()), updated_at = NOW()
          WHERE root_turn_id = $1
          RETURNING root_turn_id`
      : `UPDATE agent_turns
            SET waiting_user_ms = waiting_user_ms + CASE
                  WHEN waiting_user_started_at IS NULL THEN 0
                  ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - waiting_user_started_at)) * 1000))::bigint
                END,
                waiting_user_started_at = NULL,
                updated_at = NOW()
          WHERE root_turn_id = $1
          RETURNING root_turn_id`,
    [rootTurnId],
  );
}

/**
 * List durable retries whose backoff has elapsed.
 *
 * This is discovery only: the recovery executor must still acquire the normal
 * `owner_token` claim before invoking Pi. Keeping claim authority in one place
 * prevents the dispatcher from becoming a second state machine.
 */
export async function findDueAgentTurnRetries(params: {
  limit?: number;
  maxAgeHours?: number;
} = {}): Promise<DueAgentTurnRetry[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 20, 100));
  const maxAgeHours = Math.max(1, Math.min(params.maxAgeHours ?? 24, 168));
  const rows = await query<{
    root_turn_id: string;
    session_id: string;
    engine_session_id: string | null;
    accepted_at: string;
  }>(
    `SELECT t.root_turn_id,
            t.session_id,
            s.pi_session_file AS engine_session_id,
            t.accepted_at::text
       FROM agent_turns t
       JOIN sessions s ON s.id = t.session_id
      WHERE t.state = 'waiting_retry'
        AND t.waiting_user_started_at IS NULL
        AND COALESCE(t.last_failure_class,'') <> 'wait_requested'
        AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= NOW())
        AND t.owner_token IS NULL
        AND s.engine = 'pi'
        AND COALESCE(t.accepted_at, t.created_at) >= NOW() - ($2::int * INTERVAL '1 hour')
        AND NOT EXISTS (
          SELECT 1 FROM messages newer_user
           WHERE newer_user.session_id = t.session_id
             AND newer_user.role = 'user'
             AND newer_user.created_at > COALESCE(t.accepted_at, t.created_at)
        )
      ORDER BY t.next_attempt_at ASC NULLS FIRST, t.accepted_at ASC
      LIMIT $1`,
    [limit, maxAgeHours],
  );
  return rows.map((row) => ({
    rootTurnId: row.root_turn_id,
    sessionId: row.session_id,
    engineSessionId: row.engine_session_id,
    acceptedAt: row.accepted_at,
  }));
}

/**
 * Claim a newly accepted foreground Pi turn without consuming recovery budget.
 *
 * Registration and claim are separate because the user message is persisted before
 * Pi opens its SDK session. A duplicate foreground runner cannot replace an active
 * owner; only the exact returned token may settle this root turn.
 */
export async function claimForegroundAgentTurn(params: {
  rootTurnId: string;
  sessionId: string;
  ownerBootId: string;
  leaseSeconds?: number;
}, readOne: typeof queryOne = queryOne): Promise<ForegroundAgentTurnClaim> {
  const leaseSeconds = Math.max(15, Math.min(params.leaseSeconds ?? 180, 600));
  const row = await readOne<{
    claimed: boolean;
    token: string | null;
    state: AgentTurnState | 'missing';
  }>(
    `WITH locked AS (
       SELECT * FROM agent_turns WHERE root_turn_id = $1 AND session_id = $2 FOR UPDATE
     ), candidate AS (
       SELECT root_turn_id, gen_random_uuid()::text AS next_token
         FROM locked
        WHERE state = 'running'
          AND owner_token IS NULL
     ), updated AS (
       UPDATE agent_turns t
          SET owner_token = candidate.next_token,
              owner_boot_id = $3,
              lease_until = NOW() + ($4::int * INTERVAL '1 second'),
              recovery_source = 'foreground',
              execution_started_at = COALESCE(execution_started_at, NOW()),
              updated_at = NOW()
         FROM candidate
        WHERE t.root_turn_id = candidate.root_turn_id
       RETURNING candidate.next_token AS token
     )
     SELECT EXISTS(SELECT 1 FROM updated) AS claimed,
            (SELECT token FROM updated) AS token,
            COALESCE((SELECT state FROM locked), 'missing') AS state`,
    [params.rootTurnId, params.sessionId, params.ownerBootId, leaseSeconds],
  );
  return {
    claimed: Boolean(row?.claimed),
    token: row?.token ?? undefined,
    state: row?.state ?? 'missing',
  };
}

/** Claim one automatic recovery attempt. A fencing token prevents stale completion. */
export async function claimAgentTurn(params: {
  rootTurnId: string;
  sessionId: string;
  source: string;
  ownerBootId: string;
  /** Startup knows every owner from another boot is dead and may fence it immediately. */
  takeoverPreviousBoot?: boolean;
  leaseSeconds?: number;
  /** Hard stop for crash-looping automatic recovery. */
  maxAttempts?: number;
}, readOne: typeof queryOne = queryOne): Promise<AgentTurnClaim> {
  const leaseSeconds = Math.max(15, Math.min(params.leaseSeconds ?? 180, 600));
  const maxAttempts = Math.max(1, Math.min(params.maxAttempts ?? 4, 20));
  const row = await readOne<{
    claimed: boolean;
    token: string | null;
    attempt: number;
    state: AgentTurnState | 'missing';
  }>(
    `WITH ensured AS (
       INSERT INTO agent_turns (root_turn_id, session_id, state)
       VALUES ($1, $2, 'running')
       ON CONFLICT (root_turn_id) DO NOTHING
     ), locked AS (
       SELECT * FROM agent_turns WHERE root_turn_id = $1 AND session_id = $2 FOR UPDATE
     ), exhausted AS (
       UPDATE agent_turns t
       SET state = 'needs_attention',
           owner_token = NULL,
           owner_boot_id = NULL,
           lease_until = NULL,
           next_attempt_at = NULL,
           last_failure_class = 'auto_resume_attempts_exhausted',
           last_error = 'Automatic recovery skipped after too many restart attempts.',
           terminal_at = NOW(),
           updated_at = NOW()
       FROM locked
       WHERE t.root_turn_id = locked.root_turn_id
         AND locked.state IN ('running', 'waiting_retry')
         AND locked.attempt_count >= $7::int
       RETURNING 1
     ), candidate AS (
       SELECT root_turn_id, attempt_count + 1 AS next_attempt, gen_random_uuid()::text AS next_token
       FROM locked
       WHERE NOT EXISTS (SELECT 1 FROM exhausted)
         AND state IN ('running', 'waiting_retry')
         AND waiting_user_started_at IS NULL
         AND attempt_count < $7::int
         AND NOT (
           state = 'running'
           AND owner_token IS NOT NULL
           AND lease_until > NOW()
           AND NOT ($5::boolean AND owner_boot_id IS DISTINCT FROM $6)
         )
         AND (state <> 'waiting_retry' OR next_attempt_at IS NULL OR next_attempt_at <= NOW())
     ), updated AS (
       UPDATE agent_turns t
       SET state = 'running', recovery_source = $3,
           attempt_count = candidate.next_attempt,
           owner_token = candidate.next_token,
           owner_boot_id = $6,
           lease_until = NOW() + ($4::int * INTERVAL '1 second'),
           next_attempt_at = NULL, updated_at = NOW()
       FROM candidate
       WHERE t.root_turn_id = candidate.root_turn_id
       RETURNING candidate.next_token AS token, candidate.next_attempt AS attempt
     )
     SELECT EXISTS(SELECT 1 FROM updated) AS claimed,
            (SELECT token FROM updated) AS token,
            COALESCE((SELECT attempt FROM updated), (SELECT attempt_count FROM locked), 0) AS attempt,
            CASE WHEN EXISTS(SELECT 1 FROM exhausted)
              THEN 'needs_attention'
              ELSE COALESCE((SELECT state FROM locked), 'missing')
            END AS state`,
    [params.rootTurnId, params.sessionId, params.source, leaseSeconds,
     Boolean(params.takeoverPreviousBoot), params.ownerBootId, maxAttempts],
  );

  return {
    claimed: Boolean(row?.claimed),
    token: row?.token ?? undefined,
    attempt: row?.attempt ?? 0,
    state: row?.state ?? 'missing',
  };
}

/** Extend the current owner's lease while a long turn is still executing. */
export async function renewAgentTurnClaim(params: {
  rootTurnId: string;
  token: string;
  ownerBootId: string;
  leaseSeconds?: number;
}): Promise<boolean> {
  const leaseSeconds = Math.max(15, Math.min(params.leaseSeconds ?? 180, 600));
  const row = await queryOne<{ renewed: boolean }>(
    `WITH updated AS (
       UPDATE agent_turns
       SET lease_until = NOW() + ($3::int * INTERVAL '1 second'), updated_at = NOW()
       WHERE root_turn_id = $1 AND owner_token = $2 AND owner_boot_id = $4 AND state = 'running'
       RETURNING 1
     ) SELECT EXISTS(SELECT 1 FROM updated) AS renewed`,
    [params.rootTurnId, params.token, leaseSeconds, params.ownerBootId],
  );
  return Boolean(row?.renewed);
}

/** Update a normal (non-recovery) turn only when no recovery owner is active. */
export async function updateUnclaimedAgentTurn(params: {
  rootTurnId: string;
  state: 'completed' | 'failed' | 'needs_attention';
  error?: string;
  assistantMessageId?: string;
}): Promise<boolean> {
  const row = await queryOne<{ updated: boolean }>(
    `WITH changed AS (
       UPDATE agent_turns
       SET state = $2, last_error = $3,
           assistant_message_id = COALESCE($4, assistant_message_id),
           completed_at = CASE WHEN $2 = 'completed' THEN NOW() ELSE completed_at END,
           terminal_at = NOW(),
           waiting_user_ms = waiting_user_ms + CASE
             WHEN waiting_user_started_at IS NULL THEN 0
             ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - waiting_user_started_at)) * 1000))::bigint
           END,
           waiting_user_started_at = NULL,
           updated_at = NOW()
       WHERE root_turn_id = $1 AND owner_token IS NULL
       RETURNING 1
     ) SELECT EXISTS(SELECT 1 FROM changed) AS updated`,
    [params.rootTurnId, params.state, params.error ?? null, params.assistantMessageId ?? null],
  );
  return Boolean(row?.updated);
}

/** Persist an explicit user stop request before touching the in-memory engine. */
export async function requestAgentTurnStop(params: {
  rootTurnId: string;
  mode: 'safe' | 'force';
}): Promise<boolean> {
  const row = await queryOne<{ updated: boolean }>(
    `WITH changed AS (
       UPDATE agent_turns
          SET state = 'stop_requested', stop_mode = $2,
              stop_requested_at = COALESCE(stop_requested_at, NOW()), updated_at = NOW()
        WHERE root_turn_id = $1
          AND state IN ('running', 'waiting_retry', 'stop_requested')
       RETURNING 1
     ) SELECT EXISTS(SELECT 1 FROM changed) AS updated`,
    [params.rootTurnId, params.mode],
  );
  return Boolean(row?.updated);
}

/** Revert a stop request that the in-memory Pi runtime could not accept. */
export async function rejectAgentTurnStopRequest(params: {
  rootTurnId: string;
  error?: string;
}): Promise<boolean> {
  const row = await queryOne<{ updated: boolean }>(
    `WITH changed AS (
       UPDATE agent_turns
          SET state = 'running', stop_mode = NULL, stop_requested_at = NULL,
              last_error = $2, updated_at = NOW()
        WHERE root_turn_id = $1 AND state = 'stop_requested'
       RETURNING 1
     ) SELECT EXISTS(SELECT 1 FROM changed) AS updated`,
    [params.rootTurnId, params.error ?? null],
  );
  return Boolean(row?.updated);
}

/** Record the terminal result of a user-requested stop. */
export async function settleAgentTurnStop(params: {
  rootTurnId: string;
  mode: 'safe' | 'force';
  error?: string;
}): Promise<boolean> {
  const state = params.mode === 'safe' ? 'stopped_clean' : 'stopped_forced';
  const row = await queryOne<{ updated: boolean }>(
    `WITH changed AS (
       UPDATE agent_turns
          SET state = $2, stop_mode = $3, stopped_at = NOW(), terminal_at = NOW(),
              owner_token = NULL, owner_boot_id = NULL, lease_until = NULL,
              next_attempt_at = NULL, last_error = $4,
              waiting_user_started_at = NULL, updated_at = NOW()
        WHERE root_turn_id = $1 AND state NOT IN ('completed', 'failed', 'needs_attention')
       RETURNING 1
     ) SELECT EXISTS(SELECT 1 FROM changed) AS updated`,
    [params.rootTurnId, state, params.mode, params.error ?? null],
  );
  return Boolean(row?.updated);
}

/** Stop a non-terminal turn even if a stale recovery owner still holds its token. */
export async function forceAgentTurnNeedsAttention(params: {
  rootTurnId: string;
  error?: string;
  failureClass?: string;
}): Promise<boolean> {
  const row = await queryOne<{ updated: boolean }>(
    `WITH changed AS (
       UPDATE agent_turns
       SET state = 'needs_attention',
           owner_token = NULL,
           owner_boot_id = NULL,
           lease_until = NULL,
           next_attempt_at = NULL,
           last_failure_class = $3,
           last_error = $2,
           terminal_at = NOW(),
           waiting_user_ms = waiting_user_ms + CASE
             WHEN waiting_user_started_at IS NULL THEN 0
             ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - waiting_user_started_at)) * 1000))::bigint
           END,
           waiting_user_started_at = NULL,
           updated_at = NOW()
       WHERE root_turn_id = $1 AND state NOT IN ('completed', 'failed', 'needs_attention')
       RETURNING 1
     ) SELECT EXISTS(SELECT 1 FROM changed) AS updated`,
    [params.rootTurnId, params.error ?? null, params.failureClass ?? null],
  );
  return Boolean(row?.updated);
}

/** Finish the current fenced attempt. Retryable failures remain durable and reclaimable after backoff. */
export async function settleAgentTurn(params: {
  rootTurnId: string;
  token: string;
  state: Exclude<AgentTurnState, 'running'>;
  error?: string;
  failureClass?: string;
  assistantMessageId?: string;
  retryDelaySeconds?: number;
}, readOne: typeof queryOne = queryOne): Promise<boolean> {
  const retryDelaySeconds = Math.max(1, Math.min(params.retryDelaySeconds ?? 20, 300));
  const row = await readOne<{ settled: boolean }>(
    `WITH updated AS (
       UPDATE agent_turns
       SET state = $3,
           owner_token = NULL,
           owner_boot_id = NULL,
           lease_until = NULL,
           next_attempt_at = CASE WHEN $3 = 'waiting_retry'
             THEN NOW() + ($7::int * INTERVAL '1 second') ELSE NULL END,
           last_failure_class = $5,
           last_error = $4,
           assistant_message_id = COALESCE($6, assistant_message_id),
           completed_at = CASE WHEN $3 = 'completed' THEN NOW() ELSE completed_at END,
           terminal_at = CASE WHEN $3 IN ('completed', 'failed', 'needs_attention') THEN NOW() ELSE terminal_at END,
           waiting_user_ms = waiting_user_ms + CASE
             WHEN waiting_user_started_at IS NULL THEN 0
             ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - waiting_user_started_at)) * 1000))::bigint
           END,
           waiting_user_started_at = NULL,
           updated_at = NOW()
       WHERE root_turn_id = $1 AND owner_token = $2
       RETURNING 1
     ) SELECT EXISTS(SELECT 1 FROM updated) AS settled`,
    [params.rootTurnId, params.token, params.state, params.error ?? null,
     params.failureClass ?? null, params.assistantMessageId ?? null, retryDelaySeconds],
  );
  return Boolean(row?.settled);
}
