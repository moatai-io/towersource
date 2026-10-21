import { voiceAdmissionFailure } from './voice-admission-state.js';
import { tryVoiceFastDirect } from './voice-fast-execution.js';
import { createVoiceTurnTelemetry } from './voice-turn-telemetry.js';
/** Owns: turn-bound voice admission, cancellation and terminal response selection. */
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { handleChat, broadcastToSession } from '../../routes/ws-handler.js';
import { getSession } from '../session/session-manager.js';
import { extractTextFromContent } from '../../utils/text.js';
import { getActiveAgentTurnTiming, rejectAgentTurnStopRequest, requestAgentTurnStop } from '../agent-turn/turn-supervisor.js';
import { getCurrentRootTurn } from '../agent-turn/current-root-turn.js';
import { getEngine } from '../../engines/index.js';
import { queryOne } from '../../db/pg-repo.js';

export class VoiceTurnError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message);
    this.name = 'VoiceTurnError';
  }
}
export interface VoiceTurnIdentity {
  voiceSessionId: string;
  sessionId: string;
  userId: number;
  turnId: string;
  revision: number;
}
export type VoiceTurnInput = VoiceTurnIdentity & { transcript: string; expiresAt?: number };
export type VoiceStreamEvent = { turnId: string; revision: number; seq: number } & (
  | { type: 'answer_delta'; text: string; channel: 'final_answer'; elapsedMs: number }
  | { type: 'done'; assistantText: string; firstTextMs: number | null; totalMs: number }
  | { type: 'error'; code: string; status: number }
);
type StreamListener = (event: VoiceStreamEvent) => void;
type VoiceStreamBody = VoiceStreamEvent extends infer E ? E extends VoiceStreamEvent ? Omit<E, 'turnId' | 'revision' | 'seq'> : never : never;
type LegacyVoiceTurnInput = { sessionId: string; userId: number; transcript: string };
type TurnRecord = {
  identity: VoiceTurnIdentity;
  transcript?: string;
  cancelled: boolean;
  fastAbort: AbortController;
  settled: boolean;
  dispatched: boolean;
  stopAccepted?: boolean;
  expiresAt: number;
  result?: Promise<string>;
  timing: ReturnType<typeof createVoiceTurnTelemetry>;
  startedAt: number;
  firstTextMs: number | null;
  events: VoiceStreamEvent[];
  listeners: Set<StreamListener>;
  streamedText: string;
  streamMessageId?: string;
  streamError?: VoiceTurnError;
};
const turns = new Map<string, TurnRecord>();
const activeVoiceTurns = new Map<string, TurnRecord>();
type VoiceSessionOwner = Pick<VoiceTurnIdentity, 'voiceSessionId' | 'sessionId' | 'userId'>;
const closedVoiceSessions = new Map<string, { owner: VoiceSessionOwner; expiresAt: number }>();
const activeStates = new Set(['running', 'waiting_retry', 'stop_requested']);
const MAX_RECORDS = 10_000;
const busy = () => new VoiceTurnError('VOICE_BUSY', 'Tower Session is busy');
const cancelled = () => new VoiceTurnError('VOICE_CANCELLED', 'Voice turn was cancelled');
const sameOwner = (a: VoiceTurnIdentity, b: VoiceTurnIdentity) =>
  a.voiceSessionId === b.voiceSessionId && a.sessionId === b.sessionId && a.userId === b.userId
  && a.turnId === b.turnId && a.revision === b.revision;
function prune() {
  for (const [key, closed] of closedVoiceSessions) {
    if (closed.expiresAt <= Date.now()) closedVoiceSessions.delete(key);
  }
  for (const [key, record] of turns) {
    if (record.settled && record.expiresAt <= Date.now()) turns.delete(key);
  }
}
function newRecord(identity: VoiceTurnIdentity, expiresAt?: number): TurnRecord {
  prune();
  // Do not evict a live capability's dedupe/tombstone record under pressure.
  if (turns.size >= MAX_RECORDS) throw busy();
  return { identity: { ...identity }, fastAbort: new AbortController(), cancelled: false, settled: false, dispatched: false,
    timing: createVoiceTurnTelemetry(identity), startedAt: Date.now(), firstTextMs: null, events: [], listeners: new Set(), streamedText: '',
    expiresAt: Math.max(expiresAt ?? 0, Date.now() + 30 * 60_000) };
}

function emitStream(record: TurnRecord, body: VoiceStreamBody) {
  const event = { ...body, turnId: record.identity.turnId, revision: record.identity.revision, seq: record.events.length + 1 } as VoiceStreamEvent;
  record.events.push(event);
  for (const listener of record.listeners) {
    try { listener(event); } catch { record.listeners.delete(listener); }
  }
}
async function observeResult(record: TurnRecord, listener?: StreamListener): Promise<string> {
  if (listener) {
    for (const event of record.events) listener(event);
    record.listeners.add(listener);
  }
  try { return await record.result!; }
  finally { if (listener) record.listeners.delete(listener); }
}

/** Only call in the execution-owning backend. Bare Session cancellation is intentionally rejected. */
export async function requestVoiceTurnCancellation(input: VoiceTurnIdentity | string): Promise<boolean> {
  if (typeof input === 'string') return false; // legacy worker compatibility; never cancel an arbitrary root
  let record = turns.get(input.turnId);
  if (record && !sameOwner(record.identity, input)) return false;
  if (!record) {
    // A cancel may overtake the HTTP turn request. Remember its exact owner/revision.
    record = newRecord(input);
    record.cancelled = true;
    record.settled = true;
    turns.set(input.turnId, record);
    return true;
  }
  record.fastAbort.abort();
  record.cancelled = true; // suppress late audio even when a safe engine stop is unavailable
  if (!record.dispatched) return true;
  if (record.settled || activeVoiceTurns.get(input.sessionId) !== record) return false;
  if (record.stopAccepted) return true;
  const active = await getActiveAgentTurnTiming(input.sessionId);
  if (active?.rootTurnId !== input.turnId || !activeStates.has(active.state)) return false;
  const session = await getSession(input.sessionId);
  // current-root-turn is authoritative for the Pi runtime only; fail closed for other engines.
  if (session?.engine !== 'pi') return false;
  const engine = await getEngine('pi');
  if (!engine.requestStopAtBoundary) return false;
  const requested = await requestAgentTurnStop({ rootTurnId: input.turnId, mode: 'safe' });
  if (!requested) return false;
  // No await between the process-local ownership check and the engine call. A delayed
  // DB lookup/getEngine must not turn A's cancellation into a stop of newer turn B.
  if (record.settled || activeVoiceTurns.get(input.sessionId) !== record
    || getCurrentRootTurn(input.sessionId) !== input.turnId) {
    await rejectAgentTurnStopRequest({ rootTurnId: input.turnId, error: 'Voice turn no longer owns the engine.' });
    return false;
  }
  const result = await engine.requestStopAtBoundary(input.sessionId).catch(() => ({ accepted: false }));
  if (!result.accepted) {
    await rejectAgentTurnStopRequest({ rootTurnId: input.turnId, error: 'Voice safe-stop request was not accepted.' });
  } else {
    record.stopAccepted = true;
  }
  return result.accepted;
}

/** Revoke admission synchronously before awaiting exact owned-turn cancellation or descriptor deletion. */
export async function closeTowerVoiceSession(owner: VoiceSessionOwner, expiresAt: number): Promise<boolean> {
  closedVoiceSessions.set(owner.voiceSessionId, {
    owner: { ...owner }, expiresAt: Math.max(expiresAt, Date.now() + 30 * 60_000),
  });
  const record = activeVoiceTurns.get(owner.sessionId);
  if (!record || record.identity.voiceSessionId !== owner.voiceSessionId || record.identity.userId !== owner.userId) return false;
  // requestVoiceTurnCancellation sets the tombstone synchronously, even if engine/DB lookup fails.
  return requestVoiceTurnCancellation(record.identity).catch(() => false);
}

/** Explicit identity is required by HTTP. Legacy local smoke callers get a fresh, non-retryable identity. */
export async function runTowerVoiceTurn(input: VoiceTurnInput | LegacyVoiceTurnInput, onEvent?: StreamListener): Promise<string> {
  const request: VoiceTurnInput = 'turnId' in input ? input : {
    ...input, voiceSessionId: uuidv4(), turnId: uuidv4(), revision: 1,
  };
  const closed = closedVoiceSessions.get(request.voiceSessionId);
  if (closed && closed.owner.sessionId === request.sessionId && closed.owner.userId === request.userId) throw cancelled();
  if (request.expiresAt !== undefined && request.expiresAt <= Date.now()) throw cancelled();
  const existing = turns.get(request.turnId);
  if (existing) {
    if (!sameOwner(existing.identity, request) || (existing.transcript !== undefined && existing.transcript !== request.transcript)) {
      throw new VoiceTurnError('VOICE_TURN_CONFLICT', 'Voice turn identity or transcript conflicts');
    }
    if (existing.cancelled) throw cancelled();
    if (existing.result) return observeResult(existing, onEvent);
  }
  if (activeVoiceTurns.has(request.sessionId)) throw busy();
  const record = newRecord(request, request.expiresAt);
  record.timing({ stage: 'gateway_received' });
  record.transcript = request.transcript;
  turns.set(request.turnId, record);
  activeVoiceTurns.set(request.sessionId, record);
  // Active execution expiry does not depend on another HTTP request/prune tick.
  // Cancellation keeps its reservation until handleChat actually returns.
  const expiration = setTimeout(() => {
    void closeTowerVoiceSession(request, request.expiresAt ?? record.expiresAt);
  }, Math.max(0, Math.min((request.expiresAt ?? record.expiresAt) - Date.now(), 2_147_483_647)));
  expiration.unref?.();
  record.result = runExclusiveTowerVoiceTurn(request, record).then((assistantText) => {
    record.timing({ stage: 'gateway_terminal' });
    emitStream(record, { type: 'done', assistantText, firstTextMs: record.firstTextMs, totalMs: Date.now() - record.startedAt });
    return assistantText;
  }, (error: unknown) => {
    record.timing({ stage: 'gateway_failed' });
    // Before the first delta, preserve ordinary HTTP errors (especially retryable BUSY).
    if (record.events.length) emitStream(record, { type: 'error', code: error instanceof VoiceTurnError ? error.code : 'VOICE_INTERNAL_ERROR', status: error instanceof VoiceTurnError ? error.status : 500 });
    throw error;
  }).finally(() => {
    clearTimeout(expiration);
    record.settled = true;
    if (activeVoiceTurns.get(request.sessionId) === record) activeVoiceTurns.delete(request.sessionId);
  });
  return observeResult(record, onEvent);
}

async function runExclusiveTowerVoiceTurn(input: VoiceTurnInput, record: TurnRecord): Promise<string> {
  const session = await getSession(input.sessionId);
  if (!session) throw new VoiceTurnError('VOICE_SESSION_NOT_FOUND', 'Tower Session not found', 404);
  // Durable protection after process-local records are lost. Never re-dispatch an old UUID.
  const prior = await queryOne<{ root_turn_id: string }>(
    'SELECT root_turn_id FROM agent_turns WHERE root_turn_id = $1', [input.turnId],
  );
  if (prior) throw new VoiceTurnError('VOICE_DUPLICATE', 'Voice turn was already dispatched');
  const active = await getActiveAgentTurnTiming(input.sessionId);
  if (active && activeStates.has(active.state)) {
    // BUSY did not execute anything: the worker may retry this same identity later.
    const code = active.state === 'waiting_retry' ? 'VOICE_RECOVERY_REQUIRED' : await voiceAdmissionFailure(input.sessionId, active.rootTurnId);
    record.timing({ stage: code === 'VOICE_BUSY' ? 'admission_live_busy' : 'admission_recovery_required' });
    if (!record.cancelled && code === 'VOICE_BUSY') turns.delete(input.turnId);
    if (record.cancelled) throw cancelled();
    throw new VoiceTurnError(code, code === 'VOICE_BUSY' ? 'Tower Session is busy' : 'Previous Tower turn requires recovery or user attention');
  }
  const actor = await queryOne<{ username: string; role: string }>(
    'SELECT username, role FROM users WHERE id = $1', [input.userId],
  );
  if (!actor) throw new VoiceTurnError('VOICE_UNAUTHORIZED', 'Voice user no longer exists', 403);
  if (record.cancelled) throw cancelled();
  record.timing({ stage: 'gateway_authority_ready' });
  let direct;
  try { direct = await tryVoiceFastDirect({ ...input, signal: record.fastAbort.signal }); }
  catch (error) {
    if (record.cancelled || record.fastAbort.signal.aborted) throw cancelled();
    if (error instanceof Error && error.message === 'VOICE_BUSY') { turns.delete(input.turnId); throw busy(); }
    throw error; // a failed/uncertain commit must never fall through into duplicate Tower work
  }
  if (record.cancelled) throw cancelled();
  if (direct) {
    // Persistence is complete. Viewer delivery is best effort and never changes execution outcome.
    try {
      broadcastToSession(input.sessionId, { type: 'user_message', sessionId: input.sessionId, message: {
        id: input.turnId, role: 'user', content: [{ type: 'text', text: input.transcript }], username: actor.username } });
      broadcastToSession(input.sessionId, { type: 'tower_message', sessionId: input.sessionId, message: { type: 'assistant', sessionId: input.sessionId,
        msgId: direct.assistantMessageId, content: [{ type: 'text', text: direct.assistantText }] } });
      broadcastToSession(input.sessionId, { type: 'turn_terminal', sessionId: input.sessionId, rootTurnId: input.turnId,
        outcome: 'completed', reason: 'voice_fast_direct', terminalAt: new Date().toISOString(), assistantMessageId: direct.assistantMessageId });
    } catch { /* durable completion remains authoritative */ }
    return direct.assistantText;
  }
  let dispatchError: VoiceTurnError | undefined;
  const sink = { readyState: WebSocket.OPEN, send(raw: string) {
    try {
      const event = JSON.parse(raw);
      if (event.type === 'error') {
        dispatchError = event.errorCode === 'VOICE_RECOVERY_REQUIRED'
          ? new VoiceTurnError('VOICE_RECOVERY_REQUIRED', 'Previous Tower turn requires recovery or user attention')
          : event.errorCode === 'VOICE_BUSY' ? busy()
          : event.errorCode === 'VOICE_TURN_NOT_STARTED'
            ? new VoiceTurnError('VOICE_TURN_NOT_STARTED', 'Voice root admission was superseded')
            : new VoiceTurnError('VOICE_DISPATCH_FAILED', 'Tower rejected the voice turn', 502);
      }
      if (event.type === 'user_message_steered' || event.type === 'user_message_queued') {
        dispatchError = new VoiceTurnError('VOICE_TURN_NOT_STARTED', 'Voice turn was not started as an independent root');
      }
    } catch { /* ignore non-JSON sink events */ }
  } } as unknown as WebSocket;
  record.dispatched = true;
  record.timing({ stage: 'chat_dispatch' });
  const execution = handleChat({
    id: `voice-${input.turnId}`, ws: sink, sessionId: input.sessionId, userId: input.userId,
    username: actor?.username || 'voice', userRole: actor?.role || 'member',
    activeQueryEpoch: 0, joinedRooms: new Set(),
    onVoiceTiming(event) {
      if (event.rootTurnId === input.turnId && event.sessionId === input.sessionId) record.timing(event);
    },
    onVoiceAnswerSnapshot(event) {
      // Preserve non-streaming JSON semantics. A streaming duplicate may subscribe
      // later; cumulative semantic snapshots can then start from their full prefix.
      if (!record.listeners.size && !record.streamMessageId) return;
      if (record.cancelled || record.streamError || event.rootTurnId !== input.turnId
        || event.sessionId !== input.sessionId || event.channel !== 'final_answer') return;
      // Streaming output is irreversible. Do not splice rewritten snapshots or another
      // assistant message into already spoken text; fail closed instead of duplicating.
      if ((record.streamMessageId && record.streamMessageId !== event.messageId)
        || !event.text.trim().startsWith(record.streamedText)
        || event.text.length > 256_000 || record.events.length >= 2048) {
        record.streamError = new VoiceTurnError('VOICE_STREAM_DIVERGED', 'Voice stream cannot be safely continued', 502);
        void requestVoiceTurnCancellation(input).catch(() => false);
        return;
      }
      const normalized = event.text.trim();
      const text = normalized.slice(record.streamedText.length);
      if (!text) return;
      record.streamMessageId = event.messageId;
      record.streamedText = normalized;
      const elapsedMs = Date.now() - record.startedAt;
      if (record.firstTextMs === null) {
        record.firstTextMs = elapsedMs;
        record.timing({ stage: 'gateway_first_text' });
      }
      emitStream(record, { type: 'answer_delta', text, channel: 'final_answer', elapsedMs });
    },
  }, {
    sessionId: input.sessionId, message: input.transcript, messageId: input.turnId,
    headless: true, voiceMode: true, suppressUserEcho: false,
    // Deliberately omit model/effort: existing Session policy is authoritative.
  });
  // A cancel can arrive while handleChat is still awaiting admission/engine startup.
  // Keep checking until execution exits; never drop its Session reservation early.
  let executionDone = false;
  const observed = execution.finally(() => { executionDone = true; });
  // Observe immediately so a rejection cannot become an unhandled Promise rejection.
  void observed.catch(() => {});
  while (!executionDone) {
    if (record.cancelled) {
      await requestVoiceTurnCancellation(input).catch(() => false);
    }
    if (!executionDone) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await observed;
  record.timing({ stage: 'chat_complete' });
  if (record.streamError) throw record.streamError;
  if (record.cancelled) throw cancelled();
  if (dispatchError) {
    // The locked admission guard reports BUSY only before input persistence.
    if (dispatchError.code === 'VOICE_BUSY') turns.delete(input.turnId);
    throw dispatchError;
  }
  const terminal = await queryOne<{ state: string; terminal_at: string | null; assistant_message_id: string | null }>(
    `SELECT state, terminal_at, assistant_message_id FROM agent_turns
      WHERE root_turn_id = $1 AND session_id = $2`, [input.turnId, input.sessionId],
  );
  if (record.cancelled || terminal?.state === 'stopped_clean' || terminal?.state === 'stopped_forced') throw cancelled();
  if (terminal?.state !== 'completed' || !terminal.terminal_at || !terminal.assistant_message_id) {
    throw new VoiceTurnError('VOICE_NO_TERMINAL_RESPONSE', 'Voice turn has no completed terminal response', 502);
  }
  const assistant = await queryOne<{ content: string }>(
    `SELECT content FROM messages WHERE session_id = $1 AND id = $2 AND role = 'assistant'`,
    [input.sessionId, terminal.assistant_message_id],
  );
  if (record.cancelled) throw cancelled();
  const text = assistant ? extractTextFromContent(assistant.content).trim() : '';
  if (!text) throw new VoiceTurnError('VOICE_NO_TERMINAL_RESPONSE', 'Voice terminal response is empty', 502);
  if (record.streamedText && (record.streamMessageId !== terminal.assistant_message_id || !text.startsWith(record.streamedText))) {
    throw new VoiceTurnError('VOICE_STREAM_DIVERGED', 'Terminal answer does not extend the streamed answer', 502);
  }
  return text;
}
