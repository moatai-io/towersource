/**
 * Engine hard switch — orchestrator.
 *
 * Single entry point that performs every step of switching the engine on an
 * existing session, in an order designed to survive a crash mid-flight.
 *
 * Steps (in order — see "Why this order" below):
 *   1. Load session and validate target engine support.
 *   2. Same-engine no-op short-circuit.
 *   3. Boundary guards — isRunning, pending tool_use.
 *   4. Load full message history; compute the rehydrate input.
 *   5. Call the target engine's rehydrateFromMessages — produces a new
 *      engineSessionId. This is the longest step but has zero DB effect
 *      so a crash here loses nothing.
 *   6. Update the target engine's per-engine session-id column on `sessions`
 *      (e.g. sessions.pi_session_file = newFile).
 *   7. recordEngineSwitch — atomic UPDATE sessions.engine + INSERT history row.
 *   8. Append a human-readable "engine switched" message to the conversation
 *      so the new engine sees a coherent boundary and the UI can render it.
 *
 * Why this order (decision doc §"Atomic-ish" walkthrough):
 *   - If we crash between 6 and 7, sessions.engine still names the OLD engine
 *     but its per-engine session-id column now points at the new file.
 *     The old engine ignores the unfamiliar column → no data loss, switch
 *     was never actually applied. User can retry.
 *   - If we crash between 7 and 8, the switch is committed but the
 *     "engine_switch" marker message is missing. Functional behaviour is
 *     correct; only the UI's visual marker is missing — a self-healing
 *     idempotent retry later can re-insert it. Acceptable.
 *   - The reverse order (recordEngineSwitch first, then per-engine column)
 *     would leave sessions.engine='pi' while pi_session_file is stale →
 *     the next turn would try to resume from a non-existent file and lose
 *     conversation context. That window is what we eliminate.
 *
 * Pure orchestration — no DB / fs / network calls happen here. All side
 * effects flow through the injected `deps` so unit tests can mock cleanly.
 *
 * See:
 *   workspace/decisions/2026-05-19-engine-hard-switch-design.md
 *   packages/backend/engines/types.ts (Engine.rehydrateFromMessages)
 *   packages/backend/services/session/session-manager.ts (recordEngineSwitch)
 */

import type { Engine, RehydrateInputMessage } from '../../engines/types.js';
import type { EngineSwitchRecord } from './session-manager.js';
import type { StoredMessage } from '../message-store.js';
import type { SessionMeta } from '@tower/shared';

// ─────────────────────────────────────────────────────────────────────
// Inputs / outputs
// ─────────────────────────────────────────────────────────────────────

export type PendingToolUsePolicy = 'fail' | 'drop_incomplete_tail';

export interface SwitchEngineInput {
  sessionId: string;
  toEngine: string;
  /** Optional per-session model to persist together with the engine switch. */
  targetModel?: string;
  /**
   * What to do if the source transcript ends in a dangling tool_use.
   *
   * The default stays strict for explicit/user-initiated switches. Automatic
   * Claude→Pi migrations on Pi-only VMs may use `drop_incomplete_tail` because
   * the source Claude engine is unavailable, so the old turn can never finish;
   * replaying it would strand the user forever.
   */
  pendingToolUsePolicy?: PendingToolUsePolicy;
  /** Free-form audit string. Goes into session_engine_history.reason. */
  reason?: string;
  /** users.id of the caller (for the audit row). */
  switchedBy?: number;
}

/**
 * Reasons the switch can fail before any state is mutated. Map directly to
 * HTTP status in the route layer (NOT_FOUND→404, SAME_ENGINE→200/no-op,
 * RUNNING/PENDING_TOOL_USE→409, UNSUPPORTED_TARGET→400, REHYDRATE_FAILED→500).
 */
export type SwitchEngineError =
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'SAME_ENGINE'; message: string; engine: string }
  | { code: 'RUNNING'; message: string }
  | { code: 'PENDING_TOOL_USE'; message: string; unmatchedToolUseIds: string[] }
  | { code: 'UNSUPPORTED_TARGET'; message: string; engine: string }
  | { code: 'REHYDRATE_FAILED'; message: string };

export interface SwitchEngineSuccess {
  ok: true;
  sessionId: string;
  fromEngine: string;
  toEngine: string;
  atTurn: number;
  /** New per-engine session identifier (Pi: file path; Claude: SDK uuid). */
  newEngineSessionId: string;
  /** Whichever sessions row column was written (e.g. 'pi_session_file'). */
  targetColumn: 'pi_session_file' | 'claude_session_id';
  /** Id of the "engine_switch" marker message inserted into `messages`. */
  systemMessageId: string;
  history: EngineSwitchRecord;
}

export type SwitchEngineResult = SwitchEngineSuccess | { ok: false; error: SwitchEngineError };

// ─────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────

/**
 * Everything switchEngine touches in the outside world goes through this
 * interface. Production callers pass real implementations; tests pass mocks.
 *
 * Why a struct of fns and not a class: keeps the call site (route handler)
 * trivially readable and the test setup explicit — no surprise side effects
 * from a hidden DI container.
 */
export interface SwitchEngineDeps {
  getSession(id: string): Promise<SessionMeta | null>;
  getMessages(sessionId: string): Promise<StoredMessage[]>;
  /** Returns the engine instance OR throws if the engine is disabled / unknown. */
  getEngine(name: string): Promise<Engine>;
  /** Pin or validate the target Pi runtime contract before its native resume file becomes authoritative. */
  ensurePiHarnessSnapshot(input: {
    sessionId: string;
    projectId?: string;
    targetModel?: string;
  }): Promise<void>;
  recordEngineSwitch(input: {
    sessionId: string;
    fromEngine: string;
    toEngine: string;
    atTurn: number;
    atMessageId?: string | null;
    reason?: string;
    fromSessionId?: string | null;
    toSessionId?: string | null;
    switchedBy?: number | null;
  }): Promise<EngineSwitchRecord>;
  updateSession(id: string, updates: Partial<SessionMeta>): Promise<void>;
  saveMessage(sessionId: string, msg: {
    id: string;
    role: string;
    content: any;
    parentToolUseId?: string | null;
    username?: string | null;
    metadata?: Record<string, any> | null;
  }): Promise<void>;
  generateMessageId(): string;
  now(): Date;
}

// ─────────────────────────────────────────────────────────────────────
// Main orchestrator
// ─────────────────────────────────────────────────────────────────────

export async function switchEngine(
  input: SwitchEngineInput,
  deps: SwitchEngineDeps,
): Promise<SwitchEngineResult> {
  const { sessionId, toEngine, targetModel, reason, switchedBy } = input;
  const pendingToolUsePolicy = input.pendingToolUsePolicy ?? 'fail';

  // ── 1. Load session ─────────────────────────────────────────────
  const session = await deps.getSession(sessionId);
  if (!session) {
    return fail({ code: 'NOT_FOUND', message: `Session ${sessionId} not found.` });
  }
  const fromEngine = session.engine ?? 'claude';

  // ── 2. Same-engine short-circuit ────────────────────────────────
  if (fromEngine === toEngine) {
    return fail({
      code: 'SAME_ENGINE',
      message: `Session already runs on '${toEngine}'. Nothing to do.`,
      engine: toEngine,
    });
  }

  // ── 3. Resolve target engine + verify it supports rehydrate ────
  let targetEngine: Engine;
  try {
    targetEngine = await deps.getEngine(toEngine);
  } catch (err: any) {
    return fail({
      code: 'UNSUPPORTED_TARGET',
      message: `Engine '${toEngine}' is not available: ${err.message}`,
      engine: toEngine,
    });
  }
  if (typeof targetEngine.rehydrateFromMessages !== 'function') {
    return fail({
      code: 'UNSUPPORTED_TARGET',
      message: `Engine '${toEngine}' cannot ingest external state (no rehydrateFromMessages). ` +
        `In Phase 1 only Pi supports being a target; Claude is a one-way exit.`,
      engine: toEngine,
    });
  }

  const targetColumn = perEngineSessionColumn(toEngine);
  if (!targetColumn) {
    return fail({
      code: 'UNSUPPORTED_TARGET',
      message: `No sessions row column mapped for engine '${toEngine}'. Migration gap — add a column before enabling this engine as a switch target.`,
      engine: toEngine,
    });
  }

  if (targetModel && !modelMatchesEngine(targetModel, toEngine)) {
    return fail({
      code: 'UNSUPPORTED_TARGET',
      message: `Model '${targetModel}' is not compatible with engine '${toEngine}'.`,
      engine: toEngine,
    });
  }

  // ── 4. Boundary guard — source engine must not be running ──────
  // We use the *source* engine's isRunning() because that's the one currently
  // owning sessionId's runtime state. The target engine has no entry yet.
  let sourceEngine: Engine;
  try {
    sourceEngine = await deps.getEngine(fromEngine);
  } catch (err: any) {
    // Source engine disabled — likely a self-hosted server where Claude is off.
    // We can still proceed because if the source can't run, nothing IS running.
    sourceEngine = { isRunning: () => false } as unknown as Engine;
  }
  if (sourceEngine.isRunning(sessionId)) {
    return fail({
      code: 'RUNNING',
      message: `Session is currently streaming on '${fromEngine}'. Wait for the turn to finish, then retry.`,
    });
  }

  // ── 5. Boundary guard — no dangling tool_use without tool_result ─
  const rawMessages = await deps.getMessages(sessionId);
  let messages = parseStoredMessages(rawMessages);
  const unmatched = findPendingToolUseIds(messages);
  let droppedPendingToolUseIds: string[] = [];
  if (unmatched.length > 0) {
    if (pendingToolUsePolicy !== 'drop_incomplete_tail') {
      return fail({
        code: 'PENDING_TOOL_USE',
        message: `Last assistant turn invoked ${unmatched.length} tool(s) that did not return a result yet (${unmatched.join(', ')}). Switch is unsafe — finish or abort the turn first.`,
        unmatchedToolUseIds: unmatched,
      });
    }
    messages = dropIncompleteTailForPendingToolUseIds(messages, unmatched);
    droppedPendingToolUseIds = unmatched;
  }

  // ── 6. Build rehydrate input (engine-agnostic shape) ───────────
  const rehydrateInput: RehydrateInputMessage[] = messages.map(m => ({
    id: m.id,
    role: m.role,
    content: m.content,
    timestamp: m.timestampMs,
  }));

  // ── 7. Rehydrate — produces the new engineSessionId. Pure file/io,
  //      no DB effect. If this throws, we abort the switch with the DB
  //      state still on the OLD engine. Safe.
  let newEngineSessionId: string;
  try {
    newEngineSessionId = await targetEngine.rehydrateFromMessages!(
      sessionId,
      rehydrateInput,
      session.cwd,
    );
  } catch (err: any) {
    return fail({
      code: 'REHYDRATE_FAILED',
      message: `Rehydrating to '${toEngine}' failed: ${err.message}`,
    });
  }

  // ── 7a. Pin the Pi Harness before recording a resumable native file ─
  // `rehydrateFromMessages()` writes a Pi sessionFile but does not know the
  // Tower DB runtime contract. If we persist that file first, the next turn
  // takes the strict resume path and rejects the Session because no immutable
  // snapshot exists. Pinning failure therefore aborts before any DB mutation;
  // the newly written file is only an orphan and cannot create an unresumable
  // Session row.
  if (toEngine === 'pi') {
    try {
      await deps.ensurePiHarnessSnapshot({
        sessionId,
        projectId: session.projectId || undefined,
        targetModel,
      });
    } catch (err: any) {
      return fail({
        code: 'REHYDRATE_FAILED',
        message: `Pinning the Pi Harness snapshot failed: ${err.message}`,
      });
    }
  }

  // ── 7b. TOCTOU narrowing — a turn may have STARTED on the source engine
  // during the rehydrate I/O above (the isRunning check at step 4 is now
  // stale). Re-check before mutating. If a turn started, abort: the fresh
  // sessionFile is just an orphan on disk (next rehydrate overwrites the
  // pointer), and no DB state changed yet. This shrinks the race window from
  // "duration of rehydrate" to "a couple of statements" — not zero, but the
  // remaining sliver can't cause context loss, only a redundant orphan file.
  if (sourceEngine.isRunning(sessionId)) {
    return fail({
      code: 'RUNNING',
      message: `A turn started on '${fromEngine}' during rehydrate. Switch aborted — retry once it finishes.`,
    });
  }

  // ── 8. Mutation order — see "Why this order" in the file header ─
  // 8a. Per-engine session id column first.
  await deps.updateSession(sessionId, {
    [targetColumn === 'pi_session_file' ? 'piSessionFile' : 'claudeSessionId']: newEngineSessionId,
    ...(targetModel ? { modelUsed: targetModel } : {}),
  } as Partial<SessionMeta>);

  // 8b. Engine swap + audit history.
  const fromSessionId = perEngineSessionId(session, fromEngine);
  const atTurn = session.turnCount ?? 0;
  const history = await deps.recordEngineSwitch({
    sessionId,
    fromEngine,
    toEngine,
    atTurn,
    reason: reason ?? 'user_request',
    fromSessionId,
    toSessionId: newEngineSessionId,
    switchedBy: switchedBy ?? null,
  });

  // 8c. Conversation marker. We insert AFTER the engine swap so the next
  // run() under the new engine sees this message as the last context entry.
  // Role 'user' is consistent with how server-resume / system-trigger
  // markers are persisted today (ws-handler.ts:2103) — frontend can branch
  // on metadata.engineSwitch for special rendering.
  const systemMessageId = deps.generateMessageId();
  await deps.saveMessage(sessionId, {
    id: systemMessageId,
    role: 'user',
    content: [{
      type: 'text',
      text: `🔀 엔진 전환: ${fromEngine} → ${toEngine}${reason ? ` (${reason})` : ''}`,
    }],
    username: '[system]',
    metadata: {
      engineSwitch: { from: fromEngine, to: toEngine, atTurn, at: deps.now().toISOString() },
      ...(droppedPendingToolUseIds.length > 0 ? {
        engineSwitchRecovery: {
          policy: pendingToolUsePolicy,
          droppedPendingToolUseIds,
        },
      } : {}),
    },
  });

  // 8d. Release the previous engine's in-memory session (memory hygiene).
  // dispose() only clears the in-RAM map (and aborts if somehow still running);
  // the on-disk native state (claude .jsonl / claudeSessionId) stays put so a
  // future switch back can still resume. Best-effort — never fails the switch.
  try { sourceEngine.dispose?.(sessionId); } catch { /* non-fatal */ }

  return {
    ok: true,
    sessionId,
    fromEngine,
    toEngine,
    atTurn,
    newEngineSessionId,
    targetColumn,
    systemMessageId,
    history,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function fail(error: SwitchEngineError): SwitchEngineResult {
  return { ok: false, error };
}

/**
 * Pi → pi_session_file. Claude → claude_session_id. Future engines add a
 * row here paired with the matching `sessions` ALTER. Returning null is the
 * one signal switchEngine treats as "not a valid target".
 */
function perEngineSessionColumn(engine: string): 'pi_session_file' | 'claude_session_id' | null {
  if (engine === 'pi') return 'pi_session_file';
  if (engine === 'claude') return 'claude_session_id';
  return null;
}

function perEngineSessionId(session: SessionMeta, engine: string): string | null {
  if (engine === 'pi') return session.piSessionFile ?? null;
  if (engine === 'claude') return session.claudeSessionId ?? null;
  return null;
}

function modelMatchesEngine(model: string, engine: string): boolean {
  if (engine === 'claude') return model.startsWith('claude-');
  if (engine === 'pi') return model.includes('/');
  if (engine === 'local') return !model.startsWith('claude-') && !model.includes('/');
  return false;
}

interface ParsedMessage {
  id: string;
  role: 'user' | 'assistant';
  content: Array<{ type: string; [k: string]: any }>;
  timestampMs?: number;
}

/**
 * True for DB messages that exist for the UI / audit but must NOT be replayed
 * into a new engine's context. Without this filter they'd be rehydrated as
 * real `user` turns and pollute the LLM:
 *   - engineSwitch marker ("🔀 엔진 전환: claude → pi") — a system note, not
 *     a user instruction. On a 2nd+ switch it would otherwise reappear as a
 *     user message.
 *   - hidden:'server-resume' / 'system-trigger' — synthetic prompts the
 *     server injects to restart a turn after a restart (ws-handler.ts:2106).
 *     They're already lossy "continue" nudges; replaying them mid-history
 *     makes the new engine think the user said "resume".
 *
 * Frontend rendering is unaffected — it reads metadata.engineSwitch directly
 * for its own (future) chip rendering; this filter only governs rehydrate.
 */
function isNonReplayableMarker(meta: Record<string, any> | null | undefined): boolean {
  if (!meta) return false;
  if (meta.engineSwitch) return true;
  if (meta.hidden === 'server-resume' || meta.hidden === 'system-trigger') return true;
  return false;
}

/**
 * Parse the JSON content column. Skip rows whose role is neither user nor
 * assistant (defensive — DB schema is free-form text). Also skip rows whose
 * content fails to parse — those represent corrupt data the rehydrate flow
 * cannot meaningfully restore. Finally, skip non-replayable markers
 * (engine-switch notes, server-resume nudges) so they never enter the new
 * engine's LLM context.
 */
function parseStoredMessages(rows: StoredMessage[]): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  for (const r of rows) {
    if (r.role !== 'user' && r.role !== 'assistant') continue;
    if (isNonReplayableMarker(r.metadata)) continue;
    let content: any;
    try {
      content = typeof r.content === 'string' ? JSON.parse(r.content) : r.content;
    } catch {
      continue;
    }
    if (!Array.isArray(content)) continue;
    out.push({
      id: r.id,
      role: r.role,
      content,
      timestampMs: r.created_at ? Date.parse(r.created_at) : undefined,
    });
  }
  return out;
}

/**
 * Returns tool_use IDs whose matching tool_result block never arrived.
 *
 * Algorithm: walk all messages in order, collect tool_use IDs from assistant
 * rows, remove an ID when a later user row references it via tool_result.
 * Whatever's left is "pending" — those tools fired but never closed, meaning
 * the conversation is mid-turn and unsafe to switch.
 *
 * Exported for the unit test that targets this edge case directly.
 */
export function findPendingToolUseIds(messages: ParsedMessage[]): string[] {
  const pending = new Map<string, true>(); // preserve insertion order
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const block of m.content) {
        if (block?.type === 'tool_use' && typeof block.id === 'string') {
          pending.set(block.id, true);
        }
      }
    } else {
      for (const block of m.content) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          pending.delete(block.tool_use_id);
        }
      }
    }
  }
  return [...pending.keys()];
}

/**
 * Return the last safe replay prefix when the transcript ends mid-tool-turn.
 *
 * A dangling tool_use belongs to an assistant turn that never completed. The
 * target engine cannot faithfully continue from that half-turn, so recovery
 * mode rehydrates only the prefix before the first still-unmatched tool_use.
 * Stored DB history is left intact for audit/UI; only the new engine's native
 * resume file receives the safe prefix.
 */
export function dropIncompleteTailForPendingToolUseIds(
  messages: ParsedMessage[],
  pendingToolUseIds: string[],
): ParsedMessage[] {
  const pending = new Set(pendingToolUseIds);
  const firstPendingIndex = messages.findIndex(m =>
    m.role === 'assistant' && m.content.some(block =>
      block?.type === 'tool_use' && typeof block.id === 'string' && pending.has(block.id),
    ),
  );
  return firstPendingIndex >= 0 ? messages.slice(0, firstPendingIndex) : messages;
}
