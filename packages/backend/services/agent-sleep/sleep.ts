// Owns bounded in-process waits. Not a durable scheduler: restart interrupts, never replays a wait.
import { config } from '../../config.js';
import { query } from '../../db/pg-repo.js';
import { getCurrentRootTurn } from '../agent-turn/current-root-turn.js';

export const MAX_SLEEP_SECONDS = 3600;
export const SLEEP_DESCRIPTION = 'Wait without model calls before the next bounded check. durationSeconds must be 1–3600; reason explains the next check. Abort/Stop cancels the wait. This is an in-process timer, NOT a durable schedule: backend restart interrupts it and requires a new user instruction. Use task-schedule for recurring work or restart-safe scheduled execution. Do not poll indefinitely or use sleep instead of a required user answer.';
export interface SleepInput { durationSeconds: number; reason: string }
export interface SleepContext { sessionId: string; rootTurnId?: string; signal?: AbortSignal }
export interface SleepResult { ok: boolean; status: 'completed' | 'cancelled'; cancelled: boolean; durationSeconds: number; reason: string; startedAt: string; wakeAt: string; finishedAt: string }
const activeWaits = new Map<string, { deadline: number; controller: AbortController }>();

export function validateSleepInput(input: SleepInput): SleepInput {
  if (!input || !Number.isInteger(input.durationSeconds) || input.durationSeconds < 1 || input.durationSeconds > MAX_SLEEP_SECONDS) {
    throw new Error(`durationSeconds must be an integer between 1 and ${MAX_SLEEP_SECONDS}.`);
  }
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 500) throw new Error('reason must contain 1–500 characters.');
  return { durationSeconds: input.durationSeconds, reason: input.reason.trim() };
}

/** Watchdogs may exempt ONLY the bounded active wait, not arbitrary idle tool calls. */
export function isSessionSleeping(sessionId: string): boolean {
  const wait = activeWaits.get(sessionId);
  return !!wait && !wait.controller.signal.aborted && Date.now() <= wait.deadline + 30_000;
}

export function cancelSessionSleep(sessionId: string): void { activeWaits.get(sessionId)?.controller.abort(); }

async function saveWait(rootTurnId: string | undefined, sessionId: string, wait: object): Promise<string> {
  // Fallback for legacy engine callers that do not supply rootTurnId: the current latest user
  // message is still durable. Refuse to start if there is no persisted owning message.
  const rows = await query<{ id: string }>(`UPDATE messages SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{sleep_wait}', $3::jsonb)
    WHERE id = COALESCE($1::text, (SELECT id FROM messages WHERE session_id = $2 AND role = 'user' ORDER BY created_at DESC, id DESC LIMIT 1))
      AND session_id = $2 AND role = 'user' RETURNING id`, [rootTurnId ?? null, sessionId, JSON.stringify(wait)]);
  if (rows.length === 0) throw new Error('Sleep requires a persisted owning user message.');
  return rows[0].id;
}

export async function sleep(input: SleepInput, ctx: SleepContext): Promise<SleepResult> {
  const params = validateSleepInput(input);
  if (activeWaits.has(ctx.sessionId)) throw new Error('Only one sleep may be active per session.');
  if (ctx.signal?.aborted) throw new Error('Sleep cancelled before starting.');
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + params.durationSeconds * 1000;
  const wakeAt = new Date(deadline).toISOString();
  let rootTurnId = getCurrentRootTurn(ctx.sessionId) ?? ctx.rootTurnId;
  const controller = new AbortController();
  const abort = () => controller.abort();
  ctx.signal?.addEventListener('abort', abort, { once: true });
  activeWaits.set(ctx.sessionId, { deadline, controller });
  try {
    rootTurnId = await saveWait(rootTurnId, ctx.sessionId, { ...params, status: 'waiting', startedAt, wakeAt, ownerBootId: config.serverEpoch });
    if (ctx.signal?.aborted) controller.abort();
    const cancelled = await new Promise<boolean>(resolve => {
      if (controller.signal.aborted) { resolve(true); return; }
      const finish = (cancelled: boolean) => { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); resolve(cancelled); };
      const onAbort = () => finish(true);
      const timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const result: SleepResult = { ok: !cancelled, status: cancelled ? 'cancelled' : 'completed', cancelled, ...params, startedAt, wakeAt, finishedAt: new Date().toISOString() };
    await saveWait(rootTurnId, ctx.sessionId, result);
    return result;
  } finally {
    ctx.signal?.removeEventListener('abort', abort);
    activeWaits.delete(ctx.sessionId);
  }
}

/** Called before generic startup recovery. A vanished timer must never become a silent model continuation. */
export async function interruptRestartedSleepTurns(): Promise<Array<{ rootTurnId: string; sessionId: string }>> {
  const rows = await query<{ root_turn_id: string; session_id: string }>(`WITH waiting AS (
    SELECT id AS root_turn_id, session_id FROM messages WHERE metadata->'sleep_wait'->>'status' = 'waiting'
      AND metadata->'sleep_wait'->>'ownerBootId' IS DISTINCT FROM $1
  ), fenced AS (
    INSERT INTO agent_turns (root_turn_id, session_id, state, last_failure_class, last_error, terminal_at)
      SELECT root_turn_id, session_id, 'needs_attention', 'sleep_restart_interrupted',
        'The server restarted during sleep. The wait was interrupted; send a new instruction to continue.', NOW() FROM waiting
    ON CONFLICT (root_turn_id) DO UPDATE SET state = 'needs_attention', owner_token = NULL, owner_boot_id = NULL,
      lease_until = NULL, next_attempt_at = NULL, terminal_at = NOW(), updated_at = NOW(),
      last_failure_class = EXCLUDED.last_failure_class, last_error = EXCLUDED.last_error
      WHERE agent_turns.state NOT IN ('completed', 'failed', 'needs_attention')
    RETURNING root_turn_id
  ) UPDATE messages m SET metadata = jsonb_set(m.metadata, '{sleep_wait,status}', '"interrupted"'::jsonb)
    FROM waiting w WHERE m.id = w.root_turn_id RETURNING w.root_turn_id, w.session_id`, [config.serverEpoch]);
  return rows.map(row => ({ rootTurnId: row.root_turn_id, sessionId: row.session_id }));
}

/** Keep the same pending iterator.next() (never issue two reads); clear timers on every exit. */
export function nextClaudeMessageWithSleep<T>(next: Promise<T>, timeoutMs: number, sleeping: () => boolean, phase: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let idleSince = Date.now();
    let wasSleeping = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const active = sleeping();
      if (active || wasSleeping) idleSince = Date.now();
      wasSleeping = active;
      const remaining = timeoutMs - (Date.now() - idleSince);
      if (remaining > 0) { timer = setTimeout(check, Math.min(remaining, 1000)); return; }
      reject(new Error(`Claude stream watchdog timeout (${phase}, ${Math.round(timeoutMs / 1000)}s)`));
    };
    timer = setTimeout(check, Math.min(timeoutMs, 1000));
    next.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
