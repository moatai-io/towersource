import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import { getEngine, getTotalActiveCount, getAllRunningSessionIds } from '../engines/index.js';
import type { EngineCallbacks, TowerMessage } from '../engines/types.js';
// Legacy: still needed for handleSetActiveSession idle cleanup until full engine migration
import { getSession as getSDKSession, cleanupSession } from '../services/ai/claude-sdk.js';
import { getFileTree, readFile, writeFile, setupFileWatcher, type FileChangeEvent } from '../services/workspace/file-system.js';
import { verifyWsToken, getUserAllowedPath } from '../services/auth/auth.js';
import { isPathSafe, expandHome } from '../services/workspace/file-system.js';
import { saveMessage, updateMessageContent, attachToolResultInDb, updateMessageMetrics, markCompactBoundary, getMessages, touchMessages, deleteMessage, findRecoverableAgentTurnForSession, markAgentTurnCheckpoint } from '../services/message-store.js';
import { recordAiRunTraceEvent } from '../services/ai-run-trace-events.js';
import { rejectAgentTurnStopRequest, requestAgentTurnStop, settleAgentTurnStop } from '../services/agent-turn/turn-supervisor.js';
import { wakeAgentTurnDispatcher, type AgentTurnDispatchCandidate } from '../services/agent-turn/turn-dispatcher.js';
import { decideTurnTerminal, toTurnTerminalMessage } from '../services/agent-turn/turn-terminal.js';
import { claimEngineSessionId, getEngineSessionId, getSession, recordEngineSwitch, updateSession, setLastAutoResumeAt } from '../services/session/session-manager.js';
import { humanChatMetadata } from '../services/session/agent-session/classification.js';
import { generateSessionName } from '../services/auto-namer.js';
import { extractTextFromContent } from '../utils/text.js';
import { execute, queryOne } from '../db/pg-repo.js';
import { config, DEFAULT_PI_MODEL_ID, getModelDefaults, normalizePiSessionModelId, shouldAutoMigrateClaudeSessionToPi } from '../config.js';
import { findSessionClient, abortCleanup, addSessionClient, removeSessionClient } from './session-guards.js';
import { spawnTask, abortTask, settleRecoveredTaskSession } from '../services/task/task-runner.js';
// damage-control moved to engines/claude-engine.ts
import { getTasks } from '../services/task/task-manager.js';
import { isPgEnabled } from '../db/pg.js';
import { canAccessRoom, canAccessSession, isPathAccessible, isPrivilegedRole, isDotfileDenied, resolveSessionProjectRoot } from '../services/pm/project-access.js';
import { accessiblePathsFallbackForRole } from './ws-access-policy.js';
import { initWsSync, publishWsSyncEvent, type WsSyncHandlers } from '../services/ws-sync.js';
import { switchEngine } from '../services/session/engine-switch.js';
import { getCommandsForUser } from '../services/skill/skill-registry.js';
import { appendProcessEvent } from '../services/process/process-map-manager.js';
import { canonicalizeSlashInput, type CommandEntry } from '../services/command-registry.js';
import { createCommandInvocationFromParsed, commandInvocationProcessEventParams, type CommandInvocation } from '../services/command-invocation.js';
import { mergeSkillInvocationMetadata, resolveSkillInvocationForMessage, skillInvocationEventPayload, skillInvocationMetadata, skillInvocationProcessEventParams, type SkillInvocation } from '../services/skill/skill-invocation.js';
import { activeSkillContextMetadata, buildActiveSkillContext } from '../services/skill/skill-context-runtime.js';
import { selectSystemPromptFragmentsForMessage, type SystemPromptFragmentKey } from '../services/system-prompt-fragments.js';
import { findProjectAgentDefinition, loadProjectAgentDefinitions } from '../services/agent-definitions.js';
import { notify } from '../services/notification-hub.js';
import { getActiveAgentTurnTiming, setAgentTurnWaitingUser } from '../services/agent-turn/turn-supervisor.js';

interface WsClient {
  id: string;
  ws: WebSocket;
  sessionId?: string;       // Tower platform session ID
  engineSessionId?: string; // Active engine-native resume ID
  userRole?: string;        // role from JWT (admin/user)
  userId?: number;          // user ID from JWT
  username?: string;        // username from JWT
  activeQueryEpoch: number; // incremented on each new query / session switch
  allowedPath?: string;     // per-user workspace path restriction
  joinedRooms: Set<string>;  // rooms this client is subscribed to (for room-guards)
}

interface PendingQuestion {
  questionId: string;
  sessionId: string;
  questions: any[];
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const SDK_HANG_TIMEOUT = 60 * 60 * 1000; // 60 minutes
const ASK_USER_TIMEOUT = 60 * 60 * 1000; // 60 minutes — product UI treats AskUserQuestion as awaiting_user, not a short-lived prompt.

const clients = new Map<string, WsClient>();
const sessionClients = new Map<string, Set<string>>(); // sessionId → Set<clientId> (1:many)
const pendingQuestions = new Map<string, PendingQuestion>(); // questionId → PendingQuestion
const REMOTE_STREAMING_TTL_MS = 5 * 60 * 1000;

type ActiveTurnTiming = {
  rootTurnId: string;
  acceptedAt: string;
  executionStartedAt?: string | null;
  waitingUserStartedAt?: string | null;
  waitingUserMs?: number;
  terminalAt?: string | null;
};

const activeTurnTimings = new Map<string, ActiveTurnTiming>();
const rootTurnStopModes = new Map<string, 'safe' | 'force'>();
const remoteStreamingSessions = new Map<string, { markedAt: number; timing?: ActiveTurnTiming }>();
const remotePendingQuestionsBySession = new Map<string, { questionId: string; questions: any[] }>();

function markRemoteStreamingSession(sessionId: string, timing?: ActiveTurnTiming): void {
  remoteStreamingSessions.set(sessionId, { markedAt: Date.now(), timing });
}

function clearRemoteStreamingSession(sessionId: string): void {
  remoteStreamingSessions.delete(sessionId);
  remotePendingQuestionsBySession.delete(sessionId);
}

function isRemoteStreamingSession(sessionId: string): boolean {
  const entry = remoteStreamingSessions.get(sessionId);
  if (!entry) return false;
  if (Date.now() - entry.markedAt <= REMOTE_STREAMING_TTL_MS) return true;
  clearRemoteStreamingSession(sessionId);
  return false;
}

async function getSlashCommandsForDispatch(args: {
  userId?: number;
  username?: string;
  projectId?: string | null;
  cwd?: string;
}): Promise<CommandEntry[]> {
  return getCommandsForUser(args.userId, args.projectId ?? null, args.username ?? null, args.cwd);
}

function resolveSlashCommandAliasForDispatch(message: string, commands: CommandEntry[]): string {
  try {
    return canonicalizeSlashInput(message, commands);
  } catch (err: any) {
    console.warn('[ws] slash command alias resolution failed:', err?.message || err);
    return message;
  }
}

function getRemoteStreamingSessionIds(): string[] {
  const ids: string[] = [];
  for (const sessionId of remoteStreamingSessions.keys()) {
    if (isRemoteStreamingSession(sessionId)) ids.push(sessionId);
  }
  return ids;
}
type SessionRecoverySnapshot = {
  isStreaming: boolean;
  pendingQuestion: { questionId: string; questions: any[] } | null;
  turnTiming: ActiveTurnTiming | null;
  durableTurnState?: 'running' | 'stop_requested' | 'waiting_retry' | 'completed' | 'stopped_clean' | 'stopped_forced' | 'failed' | 'needs_attention' | null;
  durableTurnError?: string | null;
  serverNow: string;
};

const pendingSnapshotRequests = new Map<string, {
  resolve: (snapshot: SessionRecoverySnapshot | null) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
let wsSyncInitStarted = false;

// ── Pending user messages — turn-busy 큐 (PR2 of mid-turn-event-c-pattern) ──
// 부모 AI 가 streaming 중일 때 사용자가 새 chat 을 보내면 SESSION_BUSY 로 거절
// 하지 않고 여기 적재. engine_done hook 이 flushPendingUserMessages 호출.
// wake 큐 (spawn-rpc.ts pendingWakes) 와 같은 패턴 — wake 와 user 는 별도 큐, user 우선.
// 결정: workspace/decisions/2026-05-10-mid-turn-event-c-pattern-and-user-chat-queue.md
type ChatPayload = {
  message: string;
  messageId?: string;
  sessionId?: string;
  engineSessionId?: string;
  claudeSessionId?: string;
  cwd?: string;
  model?: string;
  commandTrigger?: 'slash' | 'picker' | 'natural-language';
  suppressUserEcho?: boolean;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  panelChat?: boolean;
  /** Internal callers run the durable turn without registering a fake UI viewer. */
  headless?: boolean;
  /** Ask the durable Agent to shape this answer for spoken Korean without changing facts. */
  voiceMode?: boolean;
  /** Internal server-side carry-over for a queued turn's original acceptance time. */
  acceptedAt?: string;
  /** Non-persistent UI hint: what the user was looking at when they sent this turn. */
  surfaceHint?: {
    type?: string;
    title?: string;
    path?: string;
    language?: string;
    harness?: string;
    capabilities?: string[];
    cadSelection?: {
      path?: string;
      cadModelArtifactPath?: string;
      view?: any;
      viewport?: any;
      selection?: any;
    };
  };
};

type PendingChatItem = {
  client: WsClient;
  data: ChatPayload;
};
const pendingUserMessages = new Map<string, PendingChatItem[]>();
const pendingRedispatchPayloads = new WeakSet<ChatPayload>();
const pendingUserAbortCooldownUntil = new Map<string, number>();
const PENDING_USER_QUEUE_MAX = 5;
const PENDING_USER_ABORT_COOLDOWN_MS = 30_000;

// Chat input idempotency — websocket frames are at-least-once in practice during
// compact/reconnect/status races. Guard before save/steer/run so duplicate
// frames cannot amplify into DB rows or model dispatches.
// Decision: workspace/decisions/2026-06-07-compact-duplicate-input-loop-guard.md
const RECENT_INPUT_ID_TTL_MS = 30 * 60 * 1000;
const RECENT_INPUT_TEXT_TTL_MS = 30 * 1000;
// Distinct message ids normally represent intentional retries. A reconnect or
// duplicated submit callback can still manufacture several ids for one click,
// though, so collapse only the immediate same-text burst and allow later retries.
const RECENT_INPUT_TEXT_BURST_MS = 1_500;
const RECENT_INPUT_TEXT_MAX_ATTEMPTS = 3;
const recentUserInputDedupe = new Map<string, number>();
const recentUserInputTextAttempts = new Map<string, { expiresAt: number; count: number; lastAcceptedAt: number }>();

function messageTextForDedupe(data: Pick<ChatPayload, 'message'>): string {
  const raw = typeof data.message === 'string' ? data.message : JSON.stringify(data.message || '');
  return raw.trim().replace(/\s+/g, ' ').slice(0, 2000);
}

function pruneRecentUserInputDedupe(now = Date.now()): void {
  if (recentUserInputDedupe.size >= 2000) {
    for (const [key, expiresAt] of recentUserInputDedupe) {
      if (expiresAt <= now) recentUserInputDedupe.delete(key);
    }
  }
  if (recentUserInputTextAttempts.size >= 2000) {
    for (const [key, state] of recentUserInputTextAttempts) {
      if (state.expiresAt <= now) recentUserInputTextAttempts.delete(key);
    }
  }
}

function userInputTextKey(sessionId: string, text: string): string {
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 24);
  return `text:${sessionId}:${hash}`;
}

function reserveUserInput(sessionId: string, data: ChatPayload): { ok: true; messageId: string; textKey: string | null } | { ok: false; messageId: string; reason: 'duplicate'; dedupeBy: 'messageId' | 'text' } {
  const now = Date.now();
  pruneRecentUserInputDedupe(now);

  const messageId = data.messageId || uuidv4();
  const idKey = `id:${sessionId}:${messageId}`;
  const text = messageTextForDedupe(data);
  const textKey = text ? userInputTextKey(sessionId, text) : '';

  const idExpiresAt = recentUserInputDedupe.get(idKey) || 0;
  if (idExpiresAt > now) return { ok: false, messageId, reason: 'duplicate', dedupeBy: 'messageId' };

  if (textKey) {
    const textState = recentUserInputTextAttempts.get(textKey);
    if (textState && textState.expiresAt > now) {
      const immediateDuplicateBurst = now - textState.lastAcceptedAt < RECENT_INPUT_TEXT_BURST_MS;
      if (immediateDuplicateBurst || textState.count >= RECENT_INPUT_TEXT_MAX_ATTEMPTS) {
        return { ok: false, messageId, reason: 'duplicate', dedupeBy: 'text' };
      }
      textState.count += 1;
      textState.lastAcceptedAt = now;
      textState.expiresAt = now + RECENT_INPUT_TEXT_TTL_MS;
    } else {
      recentUserInputTextAttempts.set(textKey, {
        expiresAt: now + RECENT_INPUT_TEXT_TTL_MS,
        count: 1,
        lastAcceptedAt: now,
      });
    }
  }

  recentUserInputDedupe.set(idKey, now + RECENT_INPUT_ID_TTL_MS);
  return { ok: true, messageId, textKey: textKey || null };
}

function releaseUserInputDedupe(sessionId: string, messageId: string | undefined, text: string | undefined): void {
  if (messageId) recentUserInputDedupe.delete(`id:${sessionId}:${messageId}`);
  const normalizedText = messageTextForDedupe({ message: text || '' });
  if (normalizedText) recentUserInputTextAttempts.delete(userInputTextKey(sessionId, normalizedText));
}

function clearPendingUserMessages(sessionId: string, reason: string): number {
  const count = pendingUserMessages.get(sessionId)?.length || 0;
  pendingUserMessages.delete(sessionId);
  if (count > 0) {
    console.log(`[ws] pending user queue cleared session=${sessionId.slice(0, 8)} count=${count} reason=${reason}`);
  }
  return count;
}

// ── Per-session chat critical-section lock ──────────────────────────────────
// `ws.on('message')` does NOT serialize its callbacks: each incoming frame fires
// its own handler concurrently. Two messages sent in quick succession therefore
// run handleChat concurrently and race on the `await getSession`/`getEngine`
// window before reaching `engine.steer()` — so the engine can receive mid-turn
// injections OUT OF ORDER (and the model sees them scrambled/duplicated; issue
// #17). This mutex serializes the *decision + steer/run-start* critical section
// per session in arrival order. handleChat releases the lock right before the
// long-running turn loop, so mid-turn steering is never blocked.
const sessionChatLocks = new Map<string, Promise<void>>();

/** Acquire the per-session chat lock; resolves with a one-shot release fn. */
async function acquireSessionChatLock(sessionId: string): Promise<() => void> {
  const prev = sessionChatLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  // The next acquirer waits for THIS holder to release (arrival order preserved).
  const tail = prev.then(() => held);
  sessionChatLocks.set(sessionId, tail);
  await prev; // wait our turn
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    // GC: if we're still the tail (no later waiter chained on), drop the entry.
    if (sessionChatLocks.get(sessionId) === tail) sessionChatLocks.delete(sessionId);
  };
}

function enqueuePendingUserMessage(sessionId: string, item: PendingChatItem): void {
  const now = Date.now();
  const cooldownUntil = pendingUserAbortCooldownUntil.get(sessionId) || 0;
  if (cooldownUntil > now) {
    console.log(`[ws] pending user queue drop session=${sessionId.slice(0, 8)} reason=abort-cooldown`);
    return;
  }

  const queue = pendingUserMessages.get(sessionId) || [];
  const nextMessageId = typeof item.data.messageId === 'string' ? item.data.messageId : '';
  const nextText = messageTextForDedupe(item.data);
  const duplicateMessageId = queue.some((existing) => {
    const existingMessageId = typeof existing.data.messageId === 'string' ? existing.data.messageId : '';
    return !!(nextMessageId && existingMessageId && nextMessageId === existingMessageId);
  });
  if (duplicateMessageId) {
    console.log(`[ws] pending user queue dedupe drop session=${sessionId.slice(0, 8)} msgId=${nextMessageId.slice(0, 8) || 'none'}`);
    return;
  }

  const sameTextInQueue = nextText
    ? queue.filter((existing) => messageTextForDedupe(existing.data) === nextText).length
    : 0;
  if (sameTextInQueue >= RECENT_INPUT_TEXT_MAX_ATTEMPTS) {
    console.log(`[ws] pending user queue retry cap drop session=${sessionId.slice(0, 8)} msgId=${nextMessageId.slice(0, 8) || 'none'} attempts=${sameTextInQueue}`);
    return;
  }

  queue.push(item);
  if (queue.length > PENDING_USER_QUEUE_MAX) {
    queue.splice(0, queue.length - PENDING_USER_QUEUE_MAX);
    console.warn(`[ws] pending user queue capped session=${sessionId.slice(0, 8)} max=${PENDING_USER_QUEUE_MAX}`);
  }
  pendingUserMessages.set(sessionId, queue);
}

/**
 * Pop the next queued user message for this session and re-dispatch it via
 * handleChat. Returns true if something was processed (caller can skip
 * flushPendingWakes for this engine_done — user input takes precedence).
 *
 * Subsequent queued messages are flushed by the next engine_done hook —
 * one-at-a-time dispatch. The handleChat call below re-enters the SESSION_BUSY
 * guard, which will be false now since this is fired from engine_done (idle).
 *
 * Decision: workspace/decisions/2026-05-10-mid-turn-event-c-pattern-and-user-chat-queue.md
 */
export async function flushPendingUserMessages(sessionId: string): Promise<boolean> {
  const now = Date.now();
  const cooldownUntil = pendingUserAbortCooldownUntil.get(sessionId) || 0;
  if (cooldownUntil > now) {
    clearPendingUserMessages(sessionId, 'abort-cooldown');
    return false;
  }
  if (cooldownUntil > 0) pendingUserAbortCooldownUntil.delete(sessionId);

  const queue = pendingUserMessages.get(sessionId) || [];
  if (queue.length === 0) {
    pendingUserMessages.delete(sessionId);
    return false;
  }
  const next = queue.shift()!;
  if (queue.length === 0) {
    pendingUserMessages.delete(sessionId);
  } else {
    pendingUserMessages.set(sessionId, queue);
  }
  // Skip if the client disconnected while waiting.
  if (next.client.ws.readyState !== WebSocket.OPEN) {
    console.log(
      `[ws] flushPendingUserMessages: client ${next.client.id.slice(0, 8)} disconnected, dropping queued message`,
    );
    // Recurse to try the next in queue (fire-and-forget — we already returned)
    void flushPendingUserMessages(sessionId).catch(() => {});
    return true;
  }
  console.log(
    `[ws] flushPendingUserMessages: dispatching queued chat session=${sessionId.slice(0, 8)} (q=${queue.length} remaining)`,
  );
  // Fire-and-forget — handleChat owns its own error path. Mark this exact
  // object as an internal redispatch so the idempotency guard does not drop the
  // queued command it already accepted while the previous turn was busy. Use a
  // WeakSet instead of a payload flag so frontend JSON cannot spoof the bypass.
  const redispatchData = { ...next.data };
  pendingRedispatchPayloads.add(redispatchData);
  handleChat(next.client, redispatchData).catch((err) => {
    console.error('[ws] flushPendingUserMessages handleChat failed:', err);
  });
  return true;
}

function getLocalPendingQuestion(sessionId: string): { questionId: string; questions: any[] } | null {
  for (const pq of pendingQuestions.values()) {
    if (pq.sessionId === sessionId) {
      return { questionId: pq.questionId, questions: pq.questions };
    }
  }
  return null;
}

function attachedToolResultForBroadcast(result: unknown): string {
  const text = typeof result === 'string' ? result : String(result);
  // Completed AUQ cards need the full structured answer envelope immediately;
  // generic tool results stay capped because they may contain large command output.
  return text.includes('"kind":"tower.ask_user_question_result"') ? text : text.slice(0, 500);
}

function normalizeAskUserQuestionText(q: any): string {
  if (typeof q === 'string') return q.trim();
  if (!q || typeof q !== 'object') return '';
  for (const key of ['question', 'title', 'prompt', 'label']) {
    const value = q[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

function sanitizeAskUserQuestions(questions: any[]): any[] {
  if (!Array.isArray(questions)) return [];
  return questions
    .map((q) => {
      const question = normalizeAskUserQuestionText(q);
      if (!question) return null;
      const raw = q && typeof q === 'object' ? q : {};
      const options = Array.isArray(raw.options)
        ? raw.options
            .map((opt: any) => {
              if (typeof opt === 'string') {
                const label = opt.trim();
                return label ? { label } : null;
              }
              if (!opt || typeof opt !== 'object') return null;
              const label = typeof opt.label === 'string' && opt.label.trim().length > 0
                ? opt.label.trim()
                : (typeof opt.value === 'string' && opt.value.trim().length > 0 ? opt.value.trim() : '');
              if (!label) return null;
              return {
                ...opt,
                label,
                description: typeof opt.description === 'string' ? opt.description : undefined,
              };
            })
            .filter(Boolean)
        : [];
      return {
        ...raw,
        question,
        options,
      };
    })
    .filter(Boolean) as any[];
}

function cancelPendingQuestionsForSession(sessionId: string, reason: string): boolean {
  let cancelled = false;
  for (const [questionId, pq] of pendingQuestions.entries()) {
    if (pq.sessionId !== sessionId) continue;
    clearTimeout(pq.timer);
    pendingQuestions.delete(questionId);
    pq.reject(new Error(reason));
    cancelled = true;
  }
  return cancelled;
}

function getCachedRemoteSnapshot(sessionId: string): SessionRecoverySnapshot | null {
  const pendingQuestion = remotePendingQuestionsBySession.get(sessionId) || null;
  const isStreaming = isRemoteStreamingSession(sessionId);
  if (!isStreaming && !pendingQuestion) return null;
  return {
    isStreaming,
    pendingQuestion,
    turnTiming: remoteStreamingSessions.get(sessionId)?.timing || null,
    serverNow: new Date().toISOString(),
  };
}

function getCachedRemotePendingQuestionSnapshot(sessionId: string): SessionRecoverySnapshot | null {
  const pendingQuestion = remotePendingQuestionsBySession.get(sessionId) || null;
  return pendingQuestion ? {
    isStreaming: false,
    pendingQuestion,
    turnTiming: remoteStreamingSessions.get(sessionId)?.timing || null,
    serverNow: new Date().toISOString(),
  } : null;
}

async function requestRemoteSessionSnapshot(sessionId: string): Promise<SessionRecoverySnapshot | null> {
  if (!isPgEnabled()) return null;

  const requestId = uuidv4();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingSnapshotRequests.delete(requestId);
      // A cached remote `streaming` marker is only a hint for the initial
      // connected payload. Do not use it as authoritative recovery state: if an
      // idle frame was missed, set_active_session/reconnect would resurrect a
      // completed turn as "running" for up to the cache TTL. Pending questions
      // are safe to preserve because they require user input and do not make
      // tool chips/spinners run.
      resolve(getCachedRemotePendingQuestionSnapshot(sessionId));
    }, 250);

    pendingSnapshotRequests.set(requestId, {
      resolve: (snapshot) => {
        clearTimeout(timer);
        pendingSnapshotRequests.delete(requestId);
        resolve(snapshot);
      },
      timer,
    });

    publishWsSyncEvent(config.serverEpoch, {
      scope: 'session',
      sessionId,
      data: { type: 'session_snapshot_request', requestId },
    });
  });
}

async function getSessionRecoverySnapshot(sessionId: string): Promise<SessionRecoverySnapshot | null> {
  const localPendingQuestion = getLocalPendingQuestion(sessionId);
  // Check both Claude SDK sessions AND other engines (Pi, Local).
  // getSDKSession is Claude-specific — Pi sessions always return undefined there,
  // causing set_active_session_ack to send isStreaming:false and clearing the sidebar "run" badge.
  const localIsStreaming = !!getSDKSession(sessionId)?.isRunning
    || getAllRunningSessionIds().includes(sessionId);
  const durableTiming = await getActiveAgentTurnTiming(sessionId).catch(() => null);
  if (localIsStreaming || localPendingQuestion) {
    return {
      isStreaming: localIsStreaming,
      pendingQuestion: localPendingQuestion,
      turnTiming: activeTurnTimings.get(sessionId) || durableTiming || null,
      durableTurnState: durableTiming?.state || null,
      durableTurnError: durableTiming?.lastError || null,
      serverNow: new Date().toISOString(),
    };
  }

  const remoteSnapshot = await requestRemoteSessionSnapshot(sessionId);
  if (remoteSnapshot?.isStreaming || remoteSnapshot?.pendingQuestion) return remoteSnapshot;
  return durableTiming ? {
    isStreaming: durableTiming.state === 'running' || durableTiming.state === 'stop_requested',
    pendingQuestion: null,
    turnTiming: durableTiming,
    durableTurnState: durableTiming.state,
    durableTurnError: durableTiming.lastError,
    serverNow: new Date().toISOString(),
  } : null;
}

function resolvePendingQuestionLocally(questionId: string | undefined, answer: string, sessionId?: string): boolean {
  if (questionId) {
    const exact = pendingQuestions.get(questionId);
    if (exact) {
      exact.resolve(answer);
      return true;
    }
  }

  if (sessionId) {
    for (const [, entry] of pendingQuestions) {
      if (entry.sessionId === sessionId) {
        entry.resolve(answer);
        return true;
      }
    }
  }

  return false;
}

async function abortSessionEverywhere(sessionId: string): Promise<void> {
  let dbSession: Awaited<ReturnType<typeof getSession>> | undefined;
  try { dbSession = await getSession(sessionId); } catch {}
  const engineName = (dbSession as any)?.engine || config.defaultEngine || 'claude';
  try {
    const engine = await getEngine(engineName);
    engine.abort(sessionId);
  } catch {}
}

function isSessionScopedAllEvent(data: any): data is { sessionId: string } {
  return typeof data?.sessionId === 'string' && [
    'session_created',
    'session_meta_update',
    'session_status',
    'session_deleted',
    'session_moved',
    'session_cloned',
    'engine_switched',
  ].includes(data.type);
}

async function localBroadcastToAll(data: any) {
  const payload = JSON.stringify(data);
  const sessionScoped = isSessionScopedAllEvent(data);
  for (const client of clients.values()) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;

    // Session-related "all" events can contain or imply private metadata
    // (title changes, owner-visible lifecycle, session id timing). Filter them
    // per connected client instead of relying on frontend stores to ignore rows.
    if (sessionScoped && client.userId && !isPrivilegedRole(client.userRole)) {
      try {
        const access = await canAccessSession(data.sessionId, client.userId, client.userRole || 'member');
        if (!access.allowed) continue;
      } catch {
        continue;
      }
    }

    client.ws.send(payload);
  }
}

/**
 * Broadcast a file_changed event with per-client ACL filtering.
 * 2026-05-02: file_changed previously leaked path strings to every client
 * regardless of access (e.g. "workspace/projects/secret-customer/X.md modified"
 * visible to outsiders). Now we check each client's role + isPathAccessible
 * before sending. Privileged (admin/operator) and unauthenticated (no auth)
 * connections see all events; others see only paths they could already read.
 */
async function localBroadcastFileChange(data: { type: 'file_changed'; event: FileChangeEvent; path: string }) {
  // Always drop dotfile/system events — noisy and privacy-sensitive.
  if (isDotfileDenied(data.path)) return;

  const payload = JSON.stringify(data);
  for (const client of clients.values()) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    // No-auth deployments preserve legacy behavior.
    if (!client.userId) {
      client.ws.send(payload);
      continue;
    }
    if (isPrivilegedRole(client.userRole)) {
      client.ws.send(payload);
      continue;
    }
    try {
      const ok = await isPathAccessible(data.path, client.userId, client.userRole || 'member');
      if (ok) client.ws.send(payload);
    } catch {
      // Swallow — file watcher must not crash on a single ACL miss.
    }
  }
}

function localBroadcastToSession(sessionId: string, data: any, excludeClientId?: string) {
  const clientIds = sessionClients.get(sessionId);
  if (!clientIds) return;
  const payload = JSON.stringify(data);
  for (const clientId of clientIds) {
    if (clientId === excludeClientId) continue;
    const client = clients.get(clientId);
    if (client?.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

function localBroadcastToRoom(_roomId: string, _data: any, _excludeClientId?: string) {
  // Internal channel subscriptions are retired. Keep the sync callback as a
  // temporary no-op until P6-B removes room scope from the shared WS bus.
}

function localBroadcastToUser(userId: number, data: any) {
  const payload = JSON.stringify(data);
  for (const client of clients.values()) {
    if (client.userId === userId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

/** Immediately close every local WebSocket authenticated as this user. */
export function disconnectUserSockets(userId: number, reason = 'account_disabled'): number {
  let disconnected = 0;
  for (const client of clients.values()) {
    if (client.userId !== userId) continue;
    disconnected++;
    client.ws.close(4003, reason.slice(0, 123));
  }
  return disconnected;
}

function handleRemoteAllEvent(data: any) {
  if (data?.type === 'session_status' && typeof data.sessionId === 'string') {
    if (data.status === 'streaming') {
      markRemoteStreamingSession(data.sessionId, data.turnTiming || undefined);
    } else if (data.status === 'idle') {
      clearRemoteStreamingSession(data.sessionId);
    }
  }

  // 2026-05-02: file_changed events from peer Tower instances must also pass
  // through per-client ACL filtering — not just locally-emitted ones.
  if (data?.type === 'file_changed' && typeof data.path === 'string') {
    void localBroadcastFileChange(data);
    return;
  }

  void localBroadcastToAll(data);
}

function handleRemoteSessionEvent(sessionId: string, data: any) {
  if (!data || typeof data !== 'object') return;

  switch (data.type) {
    case 'session_snapshot_request': {
      const localPendingQuestion = getLocalPendingQuestion(sessionId);
      // Same fix as getSessionRecoverySnapshot: include Pi/Local engines, not just Claude SDK.
      const localIsStreaming = !!getSDKSession(sessionId)?.isRunning
        || getAllRunningSessionIds().includes(sessionId);
      if (!localIsStreaming && !localPendingQuestion) return;
      publishWsSyncEvent(config.serverEpoch, {
        scope: 'session',
        sessionId,
        data: {
          type: 'session_snapshot_response',
          requestId: data.requestId,
          isStreaming: localIsStreaming,
          pendingQuestion: localPendingQuestion,
          turnTiming: activeTurnTimings.get(sessionId) || null,
          serverNow: new Date().toISOString(),
        },
      });
      return;
    }
    case 'session_snapshot_response': {
      if (data.isStreaming) {
        markRemoteStreamingSession(sessionId, data.turnTiming || undefined);
      } else {
        clearRemoteStreamingSession(sessionId);
      }
      if (data.pendingQuestion) {
        remotePendingQuestionsBySession.set(sessionId, data.pendingQuestion);
      }
      const pending = pendingSnapshotRequests.get(data.requestId);
      if (!pending) return;
      pending.resolve({
        isStreaming: !!data.isStreaming,
        pendingQuestion: data.pendingQuestion || null,
        turnTiming: data.turnTiming || null,
        serverNow: data.serverNow || new Date().toISOString(),
      });
      return;
    }
    case 'answer_question_sync': {
      remotePendingQuestionsBySession.delete(sessionId);
      resolvePendingQuestionLocally(data.questionId, data.answer, sessionId);
      return;
    }
    case 'abort_session_sync': {
      clearRemoteStreamingSession(sessionId);
      cancelPendingQuestionsForSession(sessionId, 'Session aborted');
      abortSessionEverywhere(sessionId).catch(() => {});
      return;
    }
    case 'ask_user':
      if (data.questionId && Array.isArray(data.questions)) {
        remotePendingQuestionsBySession.set(sessionId, { questionId: data.questionId, questions: data.questions });
      }
      break;
    case 'ask_user_timeout':
    case 'sdk_done':
      remotePendingQuestionsBySession.delete(sessionId);
      break;
    case 'error':
      if (data.sessionId === sessionId) {
        remotePendingQuestionsBySession.delete(sessionId);
      }
      break;
  }

  localBroadcastToSession(sessionId, data);
}

const wsSyncHandlers: WsSyncHandlers = {
  all(data) {
    handleRemoteAllEvent(data);
  },
  session(sessionId, data) {
    handleRemoteSessionEvent(sessionId, data);
  },
  room(roomId, data) {
    localBroadcastToRoom(roomId, data);
  },
  user(userId, data) {
    localBroadcastToUser(userId, data);
  },
};

/**
 * Claim the active engine's native session id for a Tower session.
 * Claude stores a UUID in claude_session_id; Pi stores a session file path in pi_session_file.
 */
async function claimActiveEngineSessionId(towerSessionId: string, engineName: string, engineSessionId: string) {
  await claimEngineSessionId(towerSessionId, engineName, engineSessionId);
}

/**
 * Server-side auto-name: runs regardless of frontend WS subscription.
 *
 * Called on engine_done from BOTH the normal handleChat path AND the
 * auto-resume path (serverSideResumeInterrupted). Previously this logic
 * lived only inline in handleChat (added 2026-04-05 in commit 89ab6989).
 * The auto-resume path (added 2026-04-09 in commit 6a9a1659) silently
 * drifted, so first turns interrupted by SIGKILL/restart never got named.
 *
 * Only names sessions with default names (first turn only):
 *  - "Session ..." → normal sessions (App.tsx creates with timestamp)
 *  - "New thread"  → AI Panel threads (ai-panel-store.createPanelThread)
 *
 * See workspace/decisions/2026-05-17-auto-name-drift-in-resume-path.md
 */
async function markAgentSessionHumanTouched(sessionId: string, username?: string | null): Promise<boolean> {
  try {
    const row = await queryOne<{ worker_id: string | null; already_touched: boolean | null }>(
      `SELECT aw.id AS worker_id,
              (aw.metadata->>'humanTouched')::boolean AS already_touched
         FROM agent_workers aw
        WHERE aw.backing_session_id = $1
        LIMIT 1`,
      [sessionId],
    );
    if (!row?.worker_id || row.already_touched === true) return false;

    await execute(
      `UPDATE agent_workers
          SET metadata = metadata || $2::jsonb,
              updated_at = NOW(),
              last_heartbeat_at = NOW()
        WHERE id = $1`,
      [
        row.worker_id,
        JSON.stringify({ humanTouched: true, humanTouchedAt: new Date().toISOString(), humanUsername: username || null }),
      ],
    );
    await execute(
      `INSERT INTO agent_events
         (id, kind, worker_id, session_id, metadata)
       VALUES (gen_random_uuid()::text, 'worker_human_touched', $1, $2, $3::jsonb)`,
      [row.worker_id, sessionId, JSON.stringify({ username: username || null })],
    );

    const fresh = await getSession(sessionId);
    broadcastToAll({
      type: 'session_meta_update',
      sessionId,
      updates: { agent: fresh?.agent || null },
    });
    return true;
  } catch (err: any) {
    console.warn(`[agent-session] human touch marker failed session=${sessionId.slice(0, 8)}:`, err?.message || err);
    return false;
  }
}

async function tryAutoNameSession(sessionId: string): Promise<void> {
  try {
    const currentSession = await getSession(sessionId);
    if (!currentSession) return;
    const hasDefaultName =
      currentSession.name?.startsWith('Session ') ||
      currentSession.name === 'New thread';
    if (!hasDefaultName || currentSession.autoNamed === 0) return;
    const msgs = await getMessages(sessionId);
    const userMsg = msgs.find((m: any) => m.role === 'user');
    const assistantMsg = msgs.find((m: any) => m.role === 'assistant');
    if (!userMsg || !assistantMsg) return;
    const userText = extractTextFromContent(userMsg.content);
    const assistantText = extractTextFromContent(assistantMsg.content);
    const name = await generateSessionName(userText, assistantText);
    await updateSession(sessionId, { name, autoNamed: 1 } as any);
    // Notify all clients so sidebar updates immediately
    broadcastToAll({ type: 'session_meta_update', sessionId, updates: { name } });
    console.log(`[auto-name] server-side named session=${sessionId.slice(0, 8)} → "${name}"`);
  } catch (err: any) {
    console.warn(`[auto-name] server-side failed for session=${sessionId.slice(0, 8)}:`, err?.message);
  }
}

/**
 * Derived events the frontend still expects in legacy shapes.
 *
 * tower_message covers streaming content directly, but a few
 * terminal/error events historically arrived as top-level
 * `sdk_done`, `resume_failed`, or `error` frames. Frontend handlers
 * still key off those types, so translate only those here.
 *
 * NOTE: we do NOT emit legacy `sdk_message` frames anymore — they
 * were a pure duplicate of tower_message for assistant/turn_done/
 * compact and doubled our WS fan-out during streaming.
 */
function towerToLegacyTerminal(msg: TowerMessage, sessionId: string): any {
  switch (msg.type) {
    case 'compact':
      // Persist a marker in DB when compact finishes so it survives reload.
      // The same markerId is sent to the frontend in the tower_message event;
      // using one stable id lets chat-store drop the later DB/live duplicate.
      if (msg.phase === 'done') {
        const markerId = msg.markerId || `compact-${sessionId}-${Date.now()}`;
        saveMessage(sessionId, {
          id: markerId,
          role: 'system',
          content: [{ type: 'text', text: '✂️ 긴 대화를 정리했습니다. 이어서 진행합니다.' }],
        }).catch(() => {});
      }
      return null;
    case 'engine_done':
      // Phase 3 PR 2 (2026-05-10): flush any wake events that arrived while
      // this parent was streaming. Without this hook the first racing wake
      // would queue and never fire. fire-and-forget — flush itself is async
      // and survives independently. Decision: 2026-05-09-l3-spawn-phase3.
      //
      // 2026-05-10 mid-turn-event PR2: user messages take precedence over wake
      // events. Try user queue first; only flush wake if nothing was popped
      // from the user queue. The handleChat re-dispatched here will produce its
      // own engine_done, which re-enters this hook and drains the next item.
      void (async () => {
        try {
          const userProcessed = await flushPendingUserMessages(sessionId);
          if (!userProcessed) {
            const m = await import('../services/session/spawn-rpc.js');
            await m.flushPendingWakes(sessionId);
          }
        } catch {
          // non-critical
        }
      })();
      return {
        type: 'sdk_done',
        sessionId,
        engineSessionId: msg.engineSessionId,
        claudeSessionId: msg.engineSessionId,
      };
    case 'engine_error':
      if (msg.recoverable) {
        return {
          type: 'resume_failed',
          sessionId,
          message: msg.message,
          retryable: msg.retryable,
        };
      }
      return {
        type: 'error',
        sessionId,
        message: msg.message,
        retryable: msg.retryable,
        errorCode: /already processing/i.test(msg.message) ? 'SESSION_BUSY' : undefined,
      };
    default:
      return null;
  }
}

function broadcastTowerMessage(sessionId: string, towerMsg: TowerMessage) {
  localBroadcastToSession(sessionId, { type: 'tower_message', sessionId, message: towerMsg });
  if (!isPgEnabled()) return;

  const published = publishWsSyncEvent(config.serverEpoch, {
    scope: 'session',
    sessionId,
    data: { type: 'tower_message', sessionId, message: towerMsg },
  });

  // PostgreSQL NOTIFY has a small payload limit. Large assistant/tool-rich
  // tower_message events can exceed it, which previously meant other tabs/devices
  // saw neither TodoWrite cards nor the final answer. Fall back to a tiny signal
  // that tells remote clients to refresh this session from REST/DB.
  if (!published && towerMsg.type === 'assistant') {
    publishWsSyncEvent(config.serverEpoch, {
      scope: 'session',
      sessionId,
      data: {
        type: 'session_refresh_needed',
        sessionId,
        reason: 'oversized_tower_message',
      },
    });
  }
}

/**
 * Broadcast a message to ALL connected clients (regardless of session).
 * Used for session status updates that affect the sidebar.
 */
export function broadcastToAll(data: any) {
  if (data?.type === 'session_status' && typeof data.sessionId === 'string' && data.status === 'idle') {
    clearRemoteStreamingSession(data.sessionId);
  }
  void localBroadcastToAll(data);
  if (!isPgEnabled()) return;
  publishWsSyncEvent(config.serverEpoch, { scope: 'all', data });
}

/**
 * Broadcast a message to ALL clients viewing a session.
 * Used for streaming-related frames (sdk_done, ask_user, errors).
 * Streaming content now goes through broadcastTowerMessage directly.
 */
function broadcastToSession(sessionId: string, data: any, excludeClientId?: string) {
  localBroadcastToSession(sessionId, data, excludeClientId);
  if (!isPgEnabled()) return;
  publishWsSyncEvent(config.serverEpoch, { scope: 'session', sessionId, data });
}

/** Retired internal-channel broadcast compatibility no-op. */
function broadcastToRoom(_roomId: string, _data: any, _excludeClientId?: string) {
  // Existing archive reads do not subscribe to live room events.
}

/**
 * Send directly to a specific client.
 * Falls back to any session viewer when the originating WS is dead (reconnection).
 * Used for client-specific messages (SESSION_BUSY, SESSION_LIMIT).
 */
function sendToClient(client: WsClient, sessionId: string, data: any) {
  const payload = JSON.stringify(data);
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(payload);
  } else {
    // Client disconnected — try any client still viewing this session
    const fallback = findSessionClient(sessionClients, clients, sessionId);
    if (fallback && fallback.ws.readyState === WebSocket.OPEN) {
      fallback.ws.send(payload);
    }
  }
}

// createCanUseTool → moved to engines/claude-engine.ts

export function broadcast(data: any) {
  void localBroadcastToAll(data);
  if (!isPgEnabled()) return;
  publishWsSyncEvent(config.serverEpoch, { scope: 'all', data });
}

export function setupWebSocket(server: Server) {
  if (!wsSyncInitStarted) {
    wsSyncInitStarted = true;
    initWsSync(config.serverEpoch, wsSyncHandlers).catch((err) => {
      wsSyncInitStarted = false;
      console.error('[ws] initWsSync failed:', err?.message || err);
    });
  }

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (info: { req: import('http').IncomingMessage }, done) => {
      if (!config.authEnabled) { done(true); return; }
      const url = new URL(info.req.url || '', 'ws://localhost');
      const token = url.searchParams.get('token');
      void verifyWsToken(token)
        .then((payload) => done(!!payload, payload ? undefined : 401, payload ? undefined : 'Unauthorized'))
        .catch(() => done(false, 503, 'Authentication state unavailable'));
    },
  });

  // Setup chokidar file watcher → broadcast changes (per-client ACL filtered).
  // Peers receive the raw event via wsSync; their handleRemoteAllEvent applies
  // the same filter for THEIR connected clients.
  setupFileWatcher(config.workspaceRoot, (event: FileChangeEvent, filePath: string) => {
    const data = { type: 'file_changed' as const, event, path: filePath };
    void localBroadcastFileChange(data);
    if (isPgEnabled()) {
      publishWsSyncEvent(config.serverEpoch, { scope: 'all', data });
    }
  });

  wss.on('connection', async (ws, req) => {
    const clientId = uuidv4();
    const client: WsClient = { id: clientId, ws, activeQueryEpoch: 0, joinedRooms: new Set() };

    // Extract user role from JWT token
    if (config.authEnabled) {
      const url = new URL(req.url || '', 'ws://localhost');
      const token = url.searchParams.get('token');
      const payload = await verifyWsToken(token);
      if (payload && typeof payload === 'object' && 'role' in payload) {
        client.userRole = payload.role;
        client.userId = payload.userId;
        client.username = payload.username;
        if (client.userId) {
          client.allowedPath = client.userRole === 'admin'
            ? os.homedir()
            : await getUserAllowedPath(client.userId);
        }
      }
    }

    clients.set(clientId, client);

    const runningSessionIds = [...new Set([...getAllRunningSessionIds(), ...getRemoteStreamingSessionIds()])];
    send(ws, {
      type: 'connected',
      clientId,
      serverEpoch: config.serverEpoch,
      serverNow: new Date().toISOString(),
      streamingSessions: runningSessionIds,
      streamingSessionRuns: runningSessionIds.map((sessionId) => ({
        sessionId,
        turnTiming: activeTurnTimings.get(sessionId) || remoteStreamingSessions.get(sessionId)?.timing || null,
      })),
    });

    // ── Protocol-level ping (binary frame) ──────────────────────────────
    // Cloudflare and mobile networks need WS protocol pings to keep alive.
    // App-level JSON ping alone isn't enough — Cloudflare may still timeout.
    let missedPongs = 0;
    ws.on('pong', () => { missedPongs = 0; });       // browser auto-replies pong
    const pingInterval = setInterval(() => {
      missedPongs++;
      if (missedPongs >= 3) { ws.terminate(); return; }  // 3 missed pongs → force close
      ws.ping();                                          // binary ping frame
    }, 30_000);                                           // 30s interval, tolerates ~90s outage
    ws.on('close', () => clearInterval(pingInterval));

    ws.on('message', async (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        await handleMessage(client, data);
      } catch (error: any) {
        send(ws, { type: 'error', message: error.message || 'Unknown error' });
      }
    });

    ws.on('close', () => {
      clients.delete(clientId);
      // Remove from session viewer set — other tabs keep their entries
      if (client.sessionId) {
        removeSessionClient(sessionClients, client.sessionId, clientId);
      }
    });

    ws.on('error', () => {
      if (client.sessionId) {
        removeSessionClient(sessionClients, client.sessionId, clientId);
      }
      clients.delete(clientId);
    });
  });

  return wss;
}

async function handleMessage(client: WsClient, data: any) {
  switch (data.type) {
    case 'chat':
      await handleChat(client, data);
      break;
    case 'abort':
      handleAbort(client, data);
      break;
    case 'request_turn_stop':
      await handleTurnStopRequest(client, data);
      break;
    case 'cancel_steer':
      await handleCancelSteer(client, data);
      break;
    case 'file_read':
      handleFileRead(client, data);
      break;
    case 'file_write':
      handleFileWrite(client, data);
      break;
    case 'file_tree':
      handleFileTree(client, data);
      break;
    case 'reconnect':
      await handleReconnect(client, data);
      break;
    case 'set_active_session':
      handleSetActiveSession(client, data);
      break;
    case 'answer_question':
      handleAnswerQuestion(client, data);
      break;
    case 'ping':
      send(client.ws, { type: 'pong' });
      break;
    case 'task_spawn': {
      const { taskId } = data;
      try {
        await spawnTask(taskId, (type, payload) => {
          // task-runner owns the single terminal Notification so manual,
          // scheduled, and recovered runs follow the same deduplicated path.
          broadcastToAll({ type, ...payload });
        }, client.userId, client.userRole, client.allowedPath);
      } catch (err: any) {
        send(client.ws, { type: 'error', message: err.message });
      }
      break;
    }
    case 'task_abort': {
      const { taskId } = data;
      const ok = abortTask(taskId);
      if (!ok) {
        send(client.ws, { type: 'error', message: 'Task not running' });
      }
      break;
    }
    case 'task_list': {
      const tasks = await getTasks(client.userId, client.userRole);
      send(client.ws, { type: 'task_list', tasks });
      break;
    }
    case 'room_join':
    case 'room_leave':
    case 'room_message':
    case 'room_typing':
    case 'room_read':
    case 'share_to_channel':
      send(client.ws, {
        type: 'error',
        errorCode: 'INTERNAL_CHANNEL_RETIRED',
        message: 'Internal channels are retired. Use AI sessions, Work, and Notifications instead.',
      });
      break;
    case 'check_session_status': {
      // Stale queue guard: frontend asks if a session is actually still streaming
      const checkSid = data.sessionId;
      if (typeof checkSid === 'string') {
        const localRunningIds = new Set(getAllRunningSessionIds());
        let actualStatus: 'streaming' | 'idle' = localRunningIds.has(checkSid) ? 'streaming' : 'idle';
        if (actualStatus === 'idle' && isPgEnabled()) {
          const remoteSnapshot = await requestRemoteSessionSnapshot(checkSid);
          actualStatus = remoteSnapshot?.isStreaming ? 'streaming' : 'idle';
        }
        console.log(`[ws] check_session_status session=${checkSid.slice(0, 8)} status=${actualStatus}`);
        const durableTiming = await getActiveAgentTurnTiming(checkSid).catch(() => null);
        const turnTiming = activeTurnTimings.get(checkSid)
          || remoteStreamingSessions.get(checkSid)?.timing
          || durableTiming
          || null;
        send(client.ws, {
          type: 'session_status_check',
          sessionId: checkSid,
          status: actualStatus,
          turnTiming,
          durableTurnState: durableTiming?.state || null,
          durableTurnError: durableTiming?.lastError || null,
          serverNow: new Date().toISOString(),
        });
      }
      break;
    }
    default:
      send(client.ws, { type: 'error', message: `Unknown message type: ${data.type}` });
  }
}

async function handleReconnect(client: WsClient, data: { sessionId?: string; engineSessionId?: string; claudeSessionId?: string }) {
  const sessionId = data.sessionId;
  if (!sessionId) {
    send(client.ws, { type: 'reconnect_result', status: 'idle' });
    return;
  }

  // Restore session context on the new client
  client.sessionId = sessionId;
  const resumeId = data.engineSessionId || data.claudeSessionId;
  if (resumeId) {
    client.engineSessionId = resumeId;
  }

  // Add to session's viewer set (1:many — doesn't evict other tabs)
  addSessionClient(sessionClients, sessionId, client.id);

  const snapshot = await getSessionRecoverySnapshot(sessionId);
  const snapshotActive = !!snapshot?.isStreaming || !!snapshot?.pendingQuestion;

  if (snapshotActive) {
    send(client.ws, {
      type: 'reconnect_result',
      status: 'streaming',
      sessionId,
      pendingQuestion: snapshot?.pendingQuestion || null,
      turnTiming: snapshot?.turnTiming || null,
      durableTurnState: snapshot?.durableTurnState || null,
      durableTurnError: snapshot?.durableTurnError || null,
      serverNow: snapshot?.serverNow || new Date().toISOString(),
    });
    return;
  }

  // Interrupted sessions are now resumed server-side (serverSideResumeInterrupted).
  // Never return 'interrupted' to the client — the server handles all resume logic.
  // If auto-resume is already running, the snapshot check above returns 'streaming'.
  // If not yet started, return 'idle' — server will start it shortly and broadcast status.
  send(client.ws, {
    type: 'reconnect_result',
    status: 'idle',
    sessionId,
    turnTiming: snapshot?.turnTiming || null,
    durableTurnState: snapshot?.durableTurnState || null,
    durableTurnError: snapshot?.durableTurnError || null,
    serverNow: snapshot?.serverNow || new Date().toISOString(),
  });
}

async function handleSetActiveSession(client: WsClient, data: { sessionId: string; engineSessionId?: string; claudeSessionId?: string }) {
  const oldSessionId = client.sessionId;
  const newSessionId = data.sessionId;
  console.log(`[ws] setActiveSession old=${oldSessionId} new=${newSessionId} client=${client.id}`);

  // Access control: verify this client can access the target session
  if (client.userId) {
    const access = await canAccessSession(newSessionId, client.userId, client.userRole || 'user');
    if (!access.allowed) {
      console.warn(`[ws] setActiveSession DENIED client=${client.id.slice(0, 8)} session=${newSessionId.slice(0, 8)} reason=${access.message}`);
      send(client.ws, { type: 'error', message: access.message, errorCode: 'ACCESS_DENIED', sessionId: newSessionId });
      return;
    }
  }

  if (oldSessionId && oldSessionId !== newSessionId) {
    // Cleanup idle SDK sessions (only if no other viewers)
    const sdkSession = getSDKSession(oldSessionId);
    if (sdkSession && !sdkSession.isRunning) {
      const viewers = sessionClients.get(oldSessionId);
      const otherViewers = viewers ? [...viewers].filter((id) => id !== client.id) : [];
      if (otherViewers.length === 0) {
        cleanupSession(oldSessionId);
      }
    }
    // Remove from old session's viewer set
    removeSessionClient(sessionClients, oldSessionId, client.id);
  }

  // Update client to new session and add to viewer set.
  // DON'T bump epoch — let any running streaming loop continue in background.
  // The loop saves to DB and broadcasts to viewers. When user returns, messages load from DB.
  client.sessionId = newSessionId;
  addSessionClient(sessionClients, newSessionId, client.id);

  // Keep internal client state engine-neutral; accept claudeSessionId only as a legacy wire alias.
  client.engineSessionId = data.engineSessionId || data.claudeSessionId || undefined;

  const snapshot = await getSessionRecoverySnapshot(newSessionId);

  send(client.ws, {
    type: 'set_active_session_ack',
    sessionId: newSessionId,
    isStreaming: !!snapshot?.isStreaming || !!snapshot?.pendingQuestion,
    pendingQuestion: snapshot?.pendingQuestion || null,
    turnTiming: snapshot?.turnTiming || null,
    durableTurnState: snapshot?.durableTurnState || null,
    durableTurnError: snapshot?.durableTurnError || null,
    serverNow: snapshot?.serverNow || new Date().toISOString(),
  });
}

async function handleCancelSteer(client: WsClient, data: { sessionId?: string; messageId?: string }) {
  const sessionId = data.sessionId || client.sessionId;
  const messageId = data.messageId;
  if (!sessionId || !messageId) {
    sendToClient(client, sessionId || 'unknown', {
      type: 'steer_cancel_failed',
      sessionId,
      messageId,
      reason: 'missing_session_or_message',
      message: '취소할 steering 메시지를 찾을 수 없습니다.',
    });
    return;
  }

  // Serialize behind any in-flight chat frame for the same session. Without this,
  // a rapid "send → cancel" can race before handleChat has actually registered
  // the steer in the Pi engine.
  const rawRelease = await acquireSessionChatLock(sessionId);
  let released = false;
  const releaseLock = () => {
    if (!released) {
      released = true;
      rawRelease();
    }
  };

  try {
    const session = await getSession(sessionId);
    const engineName = session?.engine || 'claude';
    const engine = await getEngine(engineName);
    if (engineName !== 'pi' || typeof engine.cancelSteer !== 'function') {
    sendToClient(client, sessionId, {
      type: 'steer_cancel_failed',
      sessionId,
      messageId,
      reason: 'unsupported_engine',
      message: '이 세션은 steering 취소를 지원하지 않습니다.',
    });
      releaseLock();
      return;
    }

    const result = await engine.cancelSteer(sessionId, messageId);
    if (!result.ok) {
    sendToClient(client, sessionId, {
      type: 'steer_cancel_failed',
      sessionId,
      messageId,
      reason: result.reason || 'cancel_failed',
      message: result.reason === 'already_consumed'
        ? '이미 AI가 읽은 메시지는 취소할 수 없습니다.'
        : 'steering 메시지를 취소하지 못했습니다.',
    });
      releaseLock();
      return;
    }

    try {
      await deleteMessage(sessionId, messageId);
    } catch (err) {
      console.error('[ws] deleteMessage (cancelled steer) failed:', err);
    }

    // Cancel means "pretend this input never happened" from the user's point of
    // view. Release both id/text dedupe keys so an immediate edit-and-resend of
    // the same wording is accepted instead of being mistaken for a replay storm.
    releaseUserInputDedupe(sessionId, messageId, result.text);

    broadcastToSession(sessionId, {
      type: 'steer_cancelled',
      sessionId,
      messageId,
      text: result.text,
    });
    console.log(`[ws] cancelled steer session=${sessionId.slice(0, 8)} msgId=${messageId.slice(0, 8)}`);
    releaseLock();
  } catch (err: any) {
    releaseLock();
    sendToClient(client, sessionId, {
      type: 'steer_cancel_failed',
      sessionId,
      messageId,
      reason: err?.message || 'cancel_failed',
      message: 'steering 메시지를 취소하지 못했습니다.',
    });
  }
}

export async function handleChat(client: WsClient, data: ChatPayload) {
  const sessionId = data.sessionId || client.sessionId;
  if (!sessionId) {
    console.error(`[ws] handleChat REJECTED: no sessionId from client=${client.id.slice(0, 8)} — frontend must create session first`);
    sendToClient(client, 'unknown', {
      type: 'error',
      message: 'No session ID provided. Please refresh the page and try again.',
      errorCode: 'NO_SESSION_ID',
      sessionId: '',
    });
    return;
  }

  const acceptedAt = data.acceptedAt && Number.isFinite(Date.parse(data.acceptedAt))
    ? data.acceptedAt
    : new Date().toISOString();
  data = { ...data, acceptedAt };

  // Panel chat: don't change client's main sessionId — panel sessions are side-channels.
  // If a normal chat frame arrives for a different session before the explicit
  // `set_active_session` frame (possible during new-session/cache-miss races),
  // move the WS subscription atomically. Otherwise this client remains in the
  // old session's viewer set and can receive another session's stream later.
  if (!data.panelChat) {
    if (client.sessionId && client.sessionId !== sessionId) {
      removeSessionClient(sessionClients, client.sessionId, client.id);
    }
    client.sessionId = sessionId;
  }

  // Only real WebSocket viewers belong in the live session subscription set.
  // Headless callers (voice/internal automation) must never leave synthetic IDs behind.
  if (!data.headless) addSessionClient(sessionClients, sessionId, client.id);

  // Serialize the decision + steer/run-start critical section per session, in
  // arrival order. Acquired BEFORE the racy getSession/getEngine awaits so two
  // quick successive messages can't reach engine.steer() out of order (issue
  // #17). Released right before the long turn loop so mid-turn steering isn't
  // blocked. `releaseLock` is idempotent and MUST be called on every exit path.
  const rawRelease = await acquireSessionChatLock(sessionId);
  let lockReleased = false;
  const releaseLock = () => { if (!lockReleased) { lockReleased = true; rawRelease(); } };

  // Resolve engine for this session. Existing Claude sessions are lazily
  // rehydrated into Pi/Smartest at the first real chat turn when either:
  //   - Claude is disabled on this VM, or
  //   - the sticky Claude model is retired (notably claude-opus-4-8).
  // This avoids a bulk migration job touching archived/idle history while still
  // making follow-up turns land on Tower's current session default.
  let dbSession: Awaited<ReturnType<typeof getSession>> | undefined;
  try { dbSession = await getSession(sessionId); } catch {}
  let engineName = (dbSession as any)?.engine || config.defaultEngine || 'claude';
  const storedSessionModel = (dbSession as any)?.modelUsed || (dbSession as any)?.model_used;
  if (dbSession && shouldAutoMigrateClaudeSessionToPi({
    engine: engineName,
    model: storedSessionModel,
    claudeEnabled: config.claudeEnabled,
    piEnabled: config.piEnabled,
  })) {
    const targetModel = DEFAULT_PI_MODEL_ID;
    const reason = !config.claudeEnabled ? 'auto_claude_disabled_smartest' : 'auto_retired_claude_model_smartest';
    const switched = await switchEngine({
      sessionId,
      toEngine: 'pi',
      targetModel,
      reason,
      // Auto migration is also the recovery path for old Claude sessions on
      // Pi-only self-hosted servers. If the previous Claude turn died after emitting a
      // tool_use but before its tool_result was saved, Claude cannot be resumed
      // here; drop that incomplete tail from the new Pi resume context instead
      // of permanently blocking the user from chatting.
      pendingToolUsePolicy: 'drop_incomplete_tail',
      ...(typeof client.userId === 'number' ? { switchedBy: client.userId } : {}),
    }, {
      getSession,
      getMessages,
      getEngine,
      ensurePiHarnessSnapshot: async ({ sessionId: targetSessionId, projectId, targetModel: requestedModel }) => {
        const { getOrPinSessionHarnessSnapshot } = await import('../services/harness/harness-store.js');
        await getOrPinSessionHarnessSnapshot({
          sessionId: targetSessionId,
          projectId,
          requestedEngine: 'pi',
          requestedModel,
          invocationKind: 'session',
        });
      },
      recordEngineSwitch,
      updateSession,
      saveMessage,
      generateMessageId: () => uuidv4(),
      now: () => new Date(),
    });

    if (!switched.ok) {
      sendToClient(client, sessionId, {
        type: 'error',
        message: `Claude is disabled and automatic Smartest migration failed: ${switched.error.message}`,
        errorCode: `AUTO_SMARTEST_${switched.error.code}`,
        sessionId,
      });
      releaseLock();
      return;
    }

    broadcastToAll({
      type: 'engine_switched',
      sessionId,
      fromEngine: switched.fromEngine,
      toEngine: switched.toEngine,
      atTurn: switched.atTurn,
      systemMessageId: switched.systemMessageId,
    });
    broadcastToAll({
      type: 'session_meta_update',
      sessionId,
      updates: { engine: 'pi', modelUsed: targetModel },
    });
    dbSession = await getSession(sessionId) ?? dbSession;
    engineName = 'pi';
    data = { ...data, model: targetModel };
  }

  let engine: Awaited<ReturnType<typeof getEngine>>;
  try {
    engine = await getEngine(engineName);
  } catch (err) {
    releaseLock(); // never leak the lock on a setup failure
    throw err;
  }

  // Guard: drop model if it doesn't match the session's engine.
  // When we drop the frontend-sent model, fall back to the session's stored
  // model_used (if it matches the engine) before letting the engine use its
  // built-in fallback — otherwise the Pi engine picks codex-mini-latest and
  // every turn dies with stopReason='error'. (See incident 2026-04-11.)
  const localModelIds = new Set((config.localModels || []).map((model: any) => String(model.id).replace(/^local:/, '')));
  const matchesEngine = (m: string | undefined, eng: string): boolean => {
    if (!m) return false;
    if (eng === 'claude') return m.startsWith('claude-');
    if (eng === 'pi') return m.includes('/'); // provider/modelId format
    if (eng === 'local') return !m.startsWith('claude-') && !m.includes('/') && (localModelIds.size === 0 || localModelIds.has(m));
    return false;
  };

  const requestedModel: string | undefined = data.model;
  let resolvedModel: string | undefined;
  if (engineName === 'pi') {
    const requestedMatches = matchesEngine(requestedModel, engineName);
    const storedModel = (dbSession as any)?.modelUsed as string | undefined;
    const sourceModel = requestedMatches ? requestedModel : storedModel;
    resolvedModel = normalizePiSessionModelId(sourceModel);
    if (requestedModel && !requestedMatches) {
      console.log(`[ws] model mismatch: dropping "${requestedModel}" for engine="${engineName}", using Pi default/model migration target "${resolvedModel}"`);
    } else if (sourceModel && sourceModel !== resolvedModel) {
      console.log(`[ws] Pi model migration: "${sourceModel}" → "${resolvedModel}" session=${sessionId.slice(0, 8)}`);
    }
  } else if (matchesEngine(requestedModel, engineName)) {
    resolvedModel = requestedModel;
  } else {
    const storedModel = (dbSession as any)?.modelUsed as string | undefined;
    if (matchesEngine(storedModel, engineName)) {
      resolvedModel = storedModel;
      if (requestedModel) {
        console.log(`[ws] model mismatch: dropping "${requestedModel}" for engine="${engineName}", using stored model "${storedModel}"`);
      }
    } else if (requestedModel) {
      console.log(`[ws] model mismatch: dropping "${requestedModel}" for engine="${engineName}" (no valid stored model)`);
    }
  }

  let reservedTextDedupeKey: string | null = null;
  const fromPendingQueue = pendingRedispatchPayloads.has(data);
  if (fromPendingQueue) pendingRedispatchPayloads.delete(data);
  if (!fromPendingQueue) {
    const reserved = reserveUserInput(sessionId, data);
    if (!reserved.ok) {
      console.warn(
        `[ws] duplicate user input dropped session=${sessionId.slice(0, 8)} msgId=${reserved.messageId.slice(0, 8)} by=${reserved.dedupeBy}`,
      );
      sendToClient(client, sessionId, {
        type: 'duplicate_user_message_dropped',
        sessionId,
        messageId: reserved.messageId,
        reason: reserved.dedupeBy,
      });
      releaseLock();
      return;
    }
    reservedTextDedupeKey = reserved.textKey;
    data = { ...data, messageId: reserved.messageId };
  } else if (!data.messageId) {
    // Should not normally happen: queued items are assigned ids before enqueue.
    // Still make the invariant explicit so downstream save/steer share one id.
    data = { ...data, messageId: uuidv4() };
  }

  console.log(`[ws] handleChat START session=${sessionId.slice(0, 8)} client=${client.id.slice(0, 8)} engine=${engineName} model=${resolvedModel || 'default'} active=${getTotalActiveCount()}`);

  if (!fromPendingQueue) {
    await markAgentSessionHumanTouched(sessionId, client.username || null);
  }

  // Engine busy: Pi can accept a mid-turn steering message. For other engines
  // (or Pi's tiny starting window before a session entry exists), enqueue until
  // engine_done and re-dispatch via flushPendingUserMessages.
  // 결정: workspace/decisions/2026-05-10-mid-turn-event-c-pattern-and-user-chat-queue.md
  if (engine.isRunning(sessionId)) {
    if (engineName === 'pi' && typeof engine.steer === 'function') {
      try {
        // Generate the msgId first and hand it to steer() so the engine can tag
        // the steer in its pending queue and later emit steer_delivered with
        // this id (frontend flips "전달 중" → "반영됨"). See GitHub issue #15.
        const steeredMsgId = data.messageId || uuidv4();
        await engine.steer(sessionId, data.message, steeredMsgId, client.username || null);
        try {
          await saveMessage(sessionId, {
            id: steeredMsgId,
            role: 'user',
            content: [{ type: 'text', text: data.message }],
            username: client.username || null,
            metadata: humanChatMetadata(),
          });
        } catch (err) {
          console.error('[ws] saveMessage (steered user) failed:', err);
        }
        // NOTE: we intentionally do NOT broadcast `user_message` here. A mid-turn
        // injection must appear at its *injection point*, not at input time, or
        // rapid successive messages bunch up at the top of the transcript
        // (GitHub issue #17). The bubble is inserted client-side when the engine
        // emits `steer_delivered` (carries text + username). DB persistence above
        // keeps reload ordering correct via the saved timestamp.
        // Reset auto-wake budget — user took control back mid-turn.
        try {
          const { resetAutoWakeCount } = await import('../services/session/spawn-rpc.js');
          resetAutoWakeCount(sessionId);
        } catch {
          // non-critical
        }
        sendToClient(client, sessionId, {
          type: 'user_message_steered',
          sessionId,
          messageId: steeredMsgId,
          message: '현재 Pi 턴에 steering 메시지로 전달했습니다.',
        });
        console.log(
          `[ws] handleChat steered session=${sessionId.slice(0, 8)} msgId=${steeredMsgId.slice(0, 8)} (busy pi)`,
        );
        releaseLock();
        return;
      } catch (err: any) {
        // Most likely the session is still in startingSessions and no Pi entry
        // exists yet. Fall through to the existing end-of-turn queue path.
        console.warn(`[ws] Pi steer failed; falling back to pending queue: ${err?.message || err}`);
      }
    }

    const queuedMsgId = data.messageId || uuidv4();
    const dataWithId = { ...data, messageId: queuedMsgId };
    try {
      await saveMessage(sessionId, {
        id: queuedMsgId,
        role: 'user',
        content: [{ type: 'text', text: data.message }],
        username: client.username || null,
        metadata: humanChatMetadata(),
      });
    } catch (err) {
      console.error('[ws] saveMessage (queued user) failed:', err);
    }
    broadcastToSession(sessionId, {
      type: 'user_message',
      sessionId,
      message: {
        id: queuedMsgId,
        role: 'user',
        content: [{ type: 'text', text: data.message }],
        username: client.username || null,
      },
    });
    // Reset auto-wake budget — user took control back even if the turn hasn't started yet
    try {
      const { resetAutoWakeCount } = await import('../services/session/spawn-rpc.js');
      resetAutoWakeCount(sessionId);
    } catch {
      // non-critical
    }
    enqueuePendingUserMessage(sessionId, { client, data: dataWithId });
    sendToClient(client, sessionId, {
      type: 'user_message_queued',
      sessionId,
      messageId: queuedMsgId,
      message: '메시지 큐에 추가됨. 현재 응답이 끝나면 자동으로 처리됩니다.',
    });
    console.log(
      `[ws] handleChat queued session=${sessionId.slice(0, 8)} msgId=${queuedMsgId.slice(0, 8)} (busy)`,
    );
    releaseLock();
    return;
  }

  // Check concurrent session limit (across all engines)
  if (getTotalActiveCount() >= config.maxConcurrentSessions) {
    sendToClient(client, sessionId, {
      type: 'error',
      message: `Concurrent session limit exceeded (max ${config.maxConcurrentSessions})`,
      errorCode: 'SESSION_LIMIT',
      sessionId,
    });
    releaseLock();
    return;
  }

  // Personal skills are deprecated/legacy-inert. Slash commands are resolved
  // from project-visible skill paths and registry command prompts only.
  const initialRunCwd = data.cwd || dbSession?.cwd || client.allowedPath || config.defaultCwd;
  const slashCommands = await getSlashCommandsForDispatch({
    userId: client.userId,
    username: client.username,
    projectId: (dbSession as any)?.projectId ?? null,
    cwd: initialRunCwd,
  });
  const { parsedSlash, invocation: activeSkillInvocation } = resolveSkillInvocationForMessage({
    message: data.message,
    commands: slashCommands,
    commandTrigger: data.commandTrigger,
  });
  const activeCommandInvocation: CommandInvocation | null = parsedSlash
    ? createCommandInvocationFromParsed({
        parsed: parsedSlash,
        originalMessage: data.message,
        trigger: data.commandTrigger === 'picker' ? 'picker' : 'slash',
      })
    : null;

  // Save user message to DB unless this is an internal/bootstrap send. Hidden
  // sends still drive the engine, but should not look like a user typed a slash command.
  const userMsgId = data.messageId || uuidv4();
  const suppressUserEcho = data.suppressUserEcho === true;
  const userMessageMetadata = mergeSkillInvocationMetadata(
    suppressUserEcho ? { ...humanChatMetadata(), hidden: 'system-trigger' } : humanChatMetadata(),
    activeSkillInvocation,
  );
  if (!suppressUserEcho) {
    try {
      await saveMessage(sessionId, {
        id: userMsgId,
        role: 'user',
        content: [{ type: 'text', text: data.message }],
        username: client.username || null,
        metadata: userMessageMetadata,
      });
    } catch (err) { console.error('[ws] saveMessage (user) failed:', err); }
  }

  // Phase 3: user took back control — reset auto-wake budget so next
  // autonomous chain can run again. Decision: 2026-05-09-l3-spawn-phase3-autonomous-orchestration.md
  try {
    const { resetAutoWakeCount } = await import('../services/session/spawn-rpc.js');
    resetAutoWakeCount(sessionId);
  } catch {
    // non-critical
  }

  // Broadcast user message to other clients viewing this session (cross-device sync)
  if (!suppressUserEcho) {
    broadcastToSession(sessionId, {
      type: 'user_message',
      sessionId,
      message: {
        id: userMsgId,
        role: 'user',
        content: [{ type: 'text', text: data.message }],
        username: client.username || null,
        metadata: userMessageMetadata,
        createdAt: new Date().toISOString(),
      },
    }, client.id);
  }

  // Resume session ID (engine-specific, stored in DB). The legacy websocket
  // field is named claudeSessionId, so only trust it for Claude sessions; Pi
  // must resume from sessions.pi_session_file or it starts from a blank context.
  // For Pi, re-read the DB row immediately before engine.run(): recovery/manual
  // repair can update sessions.pi_session_file while a browser tab still holds
  // stale client/session state, and the DB pointer must win.
  if (engineName === 'pi') {
    try { dbSession = await getSession(sessionId) ?? dbSession; } catch {}
  }
  const dbEngineSessionId = getEngineSessionId(dbSession) || undefined;
  const clientEngineSessionId = engineName === 'claude'
    ? (data.engineSessionId || data.claudeSessionId || undefined)
    : undefined;
  const engineSessionId = engineName === 'pi'
    ? dbEngineSessionId
    : (clientEngineSessionId || dbEngineSessionId);

  if (engineName === 'pi') {
    try {
      await markAgentTurnCheckpoint(userMsgId, {
        status: 'started',
        sessionId,
        engine: engineName,
        model: data.model || (dbSession as any)?.modelUsed || (dbSession as any)?.model_used || null,
        engineSessionId: engineSessionId || null,
        acceptedAt,
      });
    } catch (err) {
      console.warn(`[ws] agent turn checkpoint start failed for ${sessionId.slice(0, 8)}:`, err);
    }
  }

  // Engine callbacks — ws-handler owns WS routing and DB access
  const callbacks: EngineCallbacks = {
    askUser: (questionId: string, questions: any[]) => {
      const sanitizedQuestions = sanitizeAskUserQuestions(questions);
      if (sanitizedQuestions.length === 0) {
        console.warn(`[ws] ask_user dropped empty payload for session=${sessionId.slice(0, 8)}`);
        return Promise.resolve('No user question payload was provided. Continue without waiting for user input.');
      }

      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          const pq = pendingQuestions.get(questionId);
          if (pq) {
            pendingQuestions.delete(questionId);
            void setAgentTurnWaitingUser(userMsgId, false).catch(() => {});
            broadcastToAll({ type: 'session_awaiting_user', sessionId, awaiting: false });
            broadcastToSession(sessionId, { type: 'ask_user_timeout', sessionId, questionId });
            // Tell AI the user didn't respond — ask again via regular chat message instead
            const questionSummary = sanitizedQuestions.map((q: any) => q.question).join(', ');
            resolve(
              `[System] The user did not respond to the interactive prompt within 60 minutes. They may have switched to another session or missed it. ` +
              `Your question was: "${questionSummary}". ` +
              `Do NOT proceed silently. Instead, ask the same question again as a regular chat message so the user can see it when they return. ` +
              `Keep your message concise and clear.`
            );
          }
        }, ASK_USER_TIMEOUT);

        void setAgentTurnWaitingUser(userMsgId, true).catch(() => {});
        pendingQuestions.set(questionId, {
          questionId,
          sessionId,
          questions: sanitizedQuestions,
          resolve: (answer: string) => {
            clearTimeout(timer);
            pendingQuestions.delete(questionId);
            resolve(answer);
          },
          reject: (error: Error) => {
            clearTimeout(timer);
            pendingQuestions.delete(questionId);
            reject(error);
          },
          timer,
        });

        // The full question stays scoped to tabs viewing this session. A content-free
        // attention edge goes to every connected client so Latest and any open main
        // tab can show `?` even when the user navigated elsewhere before AUQ arrived.
        broadcastToAll({ type: 'session_awaiting_user', sessionId, awaiting: true, questionId });
        broadcastToSession(sessionId, {
          type: 'ask_user',
          sessionId,
          questionId,
          questions: sanitizedQuestions,
        });
      });
    },
    claimSessionId: async (esid: string) => {
      try { await claimActiveEngineSessionId(sessionId, engineName, esid); } catch {}
    },
    saveMessage: async (msg) => {
      const enrichedMsg = msg.role === 'assistant' && activeSkillInvocation
        ? { ...msg, metadata: mergeSkillInvocationMetadata(msg.metadata || {}, activeSkillInvocation) }
        : msg;
      try { await saveMessage(sessionId, enrichedMsg); } catch {}
    },
    updateMessageContent: async (msgId, content) => {
      try { await updateMessageContent(msgId, content); } catch {}
    },
    attachToolResult: async (toolUseId, result) => {
      try { await attachToolResultInDb(sessionId, toolUseId, result); } catch {}
      broadcastPresentFileIntent(client.userId, sessionId, toolUseId, result);
      // Notify frontend so AgentCard/ToolChip can update status (Running → Done)
      broadcastToSession(sessionId, {
        type: 'tool_result_attached',
        sessionId,
        toolUseId,
        result: attachedToolResultForBroadcast(result),
      });
    },
    updateMessageMetrics: async (msgId, metrics) => {
      try {
        await updateMessageMetrics(msgId, {
          duration_ms: metrics.durationMs,
          finalize_completed_at: metrics.finalizeCompletedAt,
          input_tokens: metrics.inputTokens,
          output_tokens: metrics.outputTokens,
          cache_read_tokens: metrics.cacheReadTokens,
          cache_creation_tokens: metrics.cacheCreationTokens,
          reasoning_tokens: metrics.reasoningTokens,
          cache_creation_1h_tokens: metrics.cacheCreation1hTokens,
          cache_creation_5m_tokens: metrics.cacheCreation5mTokens,
          cost_usd: metrics.costUsd,
          context_input_tokens: metrics.contextInputTokens,
          context_window_size: metrics.contextWindowSize,
          context_estimated_tokens: metrics.contextEstimatedTokens,
          next_request_estimated_tokens: metrics.nextRequestEstimatedTokens,
          compact_threshold_tokens: metrics.compactThresholdTokens,
          context_snapshot: metrics.contextSnapshot,
        });
      } catch {}
    },
    recordTraceEvent: async (event) => {
      try {
        await recordAiRunTraceEvent({
          sessionId,
          rootTurnId: userMsgId,
          messageId: event.messageId || null,
          projectId: (dbSession as any)?.projectId ?? null,
          actorUserId: client.userId ?? null,
          engine: engineName,
          model: resolvedModel || null,
          eventType: event.eventType,
          visibility: event.visibility,
          payload: event.payload,
        });
      } catch (err) {
        console.warn(`[ws] recordTraceEvent failed for ${sessionId.slice(0, 8)}:`, (err as any)?.message || err);
      }
    },
    markCompactBoundary: async (msgId, meta) => {
      try {
        await markCompactBoundary(msgId, meta);
      } catch (err) {
        console.error('[ws] markCompactBoundary failed:', (err as any)?.message);
      }
    },
  };

  // Hang detection timer
  let hangTimer: ReturnType<typeof setTimeout> | null = null;
  const resetHangTimer = () => {
    if (hangTimer) clearTimeout(hangTimer);
    hangTimer = setTimeout(() => {
      engine.abort(sessionId);
      broadcastToSession(sessionId, {
        type: 'error',
        message: 'SDK response timed out. Session has been aborted.',
        errorCode: 'SDK_HANG',
        sessionId,
      });
    }, SDK_HANG_TIMEOUT);
  };

  let finalMessage = resolveSlashCommandAliasForDispatch(data.message, slashCommands);

  const appendCommandProcessEvent = async (phase: 'started' | 'completed' | 'failed', error?: string) => {
    if (!activeCommandInvocation) return;
    try {
      await appendProcessEvent(commandInvocationProcessEventParams({
        projectId: (dbSession as any)?.projectId ?? null,
        sessionId,
        invocation: activeCommandInvocation,
        phase,
        error,
      }));
    } catch (err: any) {
      console.warn(`[ws] append command_invocation ${phase} event failed:`, err?.message || err);
    }
  };

  if (activeCommandInvocation) await appendCommandProcessEvent('started');

  if (parsedSlash?.command.dispatch.type === 'native' && parsedSlash.command.dispatch.target === 'task.list') {
    const tasks = await getTasks(client.userId, client.userRole);
    sendToClient(client, sessionId, { type: 'task_list', tasks });
    sendToClient(client, sessionId, {
      type: 'command_executed',
      sessionId,
      commandId: parsedSlash.command.id,
      message: `태스크 목록을 갱신했습니다. (${tasks.length}개)`,
      uiAction: parsedSlash.command.uiAction,
    });
    await appendCommandProcessEvent('completed');
    releaseLock();
    return;
  }

  if (parsedSlash?.command.dispatch.type === 'native' && parsedSlash.command.dispatch.target === 'skills.open') {
    sendToClient(client, sessionId, {
      type: 'command_executed',
      sessionId,
      commandId: parsedSlash.command.id,
      message: '스킬 목록을 열었습니다.',
      uiAction: parsedSlash.command.uiAction,
    });
    await appendCommandProcessEvent('completed');
    releaseLock();
    return;
  }

  if (activeSkillInvocation) {
    const activeSkillContext = buildActiveSkillContext(activeSkillInvocation);
    finalMessage = activeSkillContext.prompt;
    sendToClient(client, sessionId, {
      ...skillInvocationEventPayload(sessionId, activeSkillInvocation),
      context: activeSkillContextMetadata(activeSkillContext),
    });
    try {
      await appendProcessEvent({
        ...skillInvocationProcessEventParams({
          projectId: (dbSession as any)?.projectId ?? null,
          sessionId,
          invocation: activeSkillInvocation,
          phase: 'started',
        }),
        rawPayload: {
          ...skillInvocationMetadata(activeSkillInvocation),
          phase: 'started',
          activeSkillContext: activeSkillContextMetadata(activeSkillContext),
        },
      });
    } catch (err: any) {
      console.warn('[ws] append skill_invocation process event failed:', err?.message || err);
    }
  }

  if (data.surfaceHint?.path) {
    const isCadHarness = data.surfaceHint.harness === 'cad'
      || data.surfaceHint.language === 'cad'
      || /\.(dxf|dwg)$/i.test(data.surfaceHint.path);
    const hintLines = [
      'Current screen hint (do not quote unless relevant):',
      `- type: ${data.surfaceHint.type || 'file'}`,
      `- file: ${data.surfaceHint.path}`,
      data.surfaceHint.language ? `- file type: ${data.surfaceHint.language}` : null,
      data.surfaceHint.harness ? `- file-scoped harness: ${data.surfaceHint.harness}` : null,
      data.surfaceHint.capabilities?.length ? `- available harness capabilities: ${data.surfaceHint.capabilities.join(', ')}` : null,
      data.surfaceHint.cadSelection?.selection ? [
        'Current CAD viewer selection:',
        `- file: ${data.surfaceHint.cadSelection.path || data.surfaceHint.path}`,
        data.surfaceHint.cadSelection.cadModelArtifactPath ? `- cad model: ${data.surfaceHint.cadSelection.cadModelArtifactPath}` : null,
        data.surfaceHint.cadSelection.selection?.cadModelArtifactPath ? `- selection cad model: ${data.surfaceHint.cadSelection.selection.cadModelArtifactPath}` : null,
        data.surfaceHint.cadSelection.view?.label ? `- view: ${data.surfaceHint.cadSelection.view.label}` : null,
        data.surfaceHint.cadSelection.view?.candidateId ? `- view candidate id: ${data.surfaceHint.cadSelection.view.candidateId}` : null,
        data.surfaceHint.cadSelection.view?.viewId ? `- view id: ${data.surfaceHint.cadSelection.view.viewId}` : null,
        data.surfaceHint.cadSelection.view?.kind ? `- view kind: ${data.surfaceHint.cadSelection.view.kind}` : null,
        data.surfaceHint.cadSelection.selection?.type ? `- selection type: ${data.surfaceHint.cadSelection.selection.type}` : null,
        data.surfaceHint.cadSelection.selection?.label ? `- label: ${data.surfaceHint.cadSelection.selection.label}` : null,
        data.surfaceHint.cadSelection.selection?.semanticObjectId ? `- semanticObjectId: ${data.surfaceHint.cadSelection.selection.semanticObjectId}` : null,
        data.surfaceHint.cadSelection.selection?.entityId ? `- entityId: ${data.surfaceHint.cadSelection.selection.entityId}` : null,
        data.surfaceHint.cadSelection.selection?.textId ? `- textId: ${data.surfaceHint.cadSelection.selection.textId}` : null,
        data.surfaceHint.cadSelection.selection?.blockInstanceId ? `- blockInstanceId: ${data.surfaceHint.cadSelection.selection.blockInstanceId}` : null,
        data.surfaceHint.cadSelection.selection?.handle ? `- handle: ${data.surfaceHint.cadSelection.selection.handle}` : null,
        data.surfaceHint.cadSelection.selection?.block ? `- block: ${data.surfaceHint.cadSelection.selection.block}` : null,
        data.surfaceHint.cadSelection.selection?.layer ? `- layer: ${data.surfaceHint.cadSelection.selection.layer}` : null,
        data.surfaceHint.cadSelection.selection?.text ? `- text: ${data.surfaceHint.cadSelection.selection.text}` : null,
        data.surfaceHint.cadSelection.selection?.bounds ? `- selection bounds: ${JSON.stringify(data.surfaceHint.cadSelection.selection.bounds)}` : null,
        data.surfaceHint.cadSelection.view?.bbox ? `- view bounds: ${JSON.stringify(data.surfaceHint.cadSelection.view.bbox)}` : null,
        data.surfaceHint.cadSelection.selection?.lookup ? `- lookup: ${data.surfaceHint.cadSelection.selection.lookup}` : null,
        '- Use this as the user\'s currently focused drawing object/region. Do not assume it is the whole drawing.',
      ].filter(Boolean).join('\n') : null,
      '',
      isCadHarness ? [
        'CAD file-scoped harness instructions:',
        '- Treat "this", "this file", "this drawing", and "the current CAD" as the CAD file above unless the user says otherwise.',
        '- Prefer thin UI / deep workflow behavior: answer in the user\'s work language (RFQ, estimate review, openings/equipment list, title/revision check, change request), not internal tool names.',
        '- Use read-only inspection first. Do not modify the original drawing. For changes, propose copy/dry-run/highlight/change-report first and ask for approval before applying edits.',
        '- When useful, call CAD-specific tools such as cad_view or project CAD Workbench artifacts/CLI to inspect, render, QA, extract text/layers/blocks, or create reports.',
        '- Ground important claims with evidence when possible: handle, layer, block/attribute, text value, coordinates/bounds, page/preview region, or artifact path.',
        '- When returning a substantive CAD result, prefer this lightweight response contract in markdown: (1) 업무 결론, (2) 근거 / 도면에서 보기 with handle/layer/coordinates when known, (3) 생성/참조 파일 as plain absolute workspace paths, (4) 다음 작업, (5) 확인 필요/한계.',
        '- To make evidence clickable in the UI, you may include a fenced `cad-evidence` JSON block with `{ "title": string, "items": [{ "label": string, "handle"?: string, "layer"?: string, "block"?: string, "text"?: string, "insert"?: number[], "bounds"?: number[], "confidence"?: "read"|"inferred"|"needs_review", "note"?: string }] }`. Only include evidence you can ground from CAD artifacts/tools.',
        '- If you create or reference CAD Workbench artifacts, print each important artifact path on its own line so the Tower file viewer can open it.',
        '- Be explicit about limits: preview-grade rendering is not engineering, safety, legal, or construction sign-off.',
        '- For large drawings, prefer progressive results: first summarize what is known, then continue deeper analysis/tooling as needed.',
        '',
      ].join('\n') : 'The user may refer to this as "this", "this file", or "the current screen". Do not assume file contents are already current; use tools to read or edit it only when the request requires it.',
      '',
      '---',
      finalMessage,
    ].filter((line): line is string => line !== null);
    finalMessage = hintLines.join('\n');
  }

  // ── Context injection for AI Panel sessions (first message only) ──
  const roomId = (dbSession as any)?.roomId;
  const parentSessionId = (dbSession as any)?.parentSessionId;
  const isFirstTurn = (dbSession?.turnCount ?? 0) === 0;

  // Channel context injection (room panel threads)
  if (roomId && isFirstTurn && isPgEnabled()) {
    try {
      const { getRoom, getMessages: getRoomMessages } = await import('../services/room/room-manager.js');
      const room = await getRoom(roomId);
      const recentMsgs = await getRoomMessages(roomId, { limit: 30 });
      if (room && recentMsgs.length > 0) {
        const contextLines = recentMsgs.map((m) => {
          const sender = m.senderName || (m.msgType === 'ai_reply' ? 'AI' : 'System');
          return `[${sender}]: ${m.content}`;
        }).join('\n');
        finalMessage = `[Channel Context: #${room.name}]\nRecent messages from the team channel (for reference):\n${contextLines}\n\nYou are assisting a team member privately in a side panel.\nFocus on answering their question below. Use the channel context only when relevant.\nThe conversation will continue in this thread — no need to re-read the channel on follow-up messages.\n\n---\n${finalMessage}`;
      }
    } catch (err: any) {
      console.warn('[ws] Channel context injection failed:', err.message);
    }
  }

  // Session context injection (session panel threads)
  if (parentSessionId && isFirstTurn && isPgEnabled()) {
    try {
      const { getMessages: getSessionMessages } = await import('../services/message-store.js');
      const parentSession = await getSession(parentSessionId);
      const allParentMsgs = await getSessionMessages(parentSessionId);
      const parentMsgs = allParentMsgs.slice(-50);
      if (parentMsgs.length > 0) {
        const contextLines = parentMsgs.map((m: any) => {
          const role = m.role === 'user' ? 'User' : 'Assistant';
          const content = typeof m.content === 'string' ? m.content : JSON.parse(m.content)
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text || '')
            .join('\n');
          return `[${role}]: ${content}`;
        }).filter((line: string) => line.trim().length > 7).join('\n');
        const sessionName = parentSession?.name || 'Session';
        finalMessage = `[Session Context: "${sessionName}"]\nHere is the conversation history from the parent session (for reference):\n${contextLines}\n\nYou are assisting the user in a side panel about this conversation.\nAnswer questions about the conversation, summarize, find details, or help analyze what was discussed.\nThe conversation will continue in this thread — no need to re-read the session on follow-up messages.\n\n---\n${finalMessage}`;
      }
    } catch (err: any) {
      console.warn('[ws] Session context injection failed:', err.message);
    }
  }

  const runCwd = initialRunCwd;
  const sessionProjectRoot = resolveSessionProjectRoot(runCwd)
    ?? ((dbSession as any)?.projectId
      ? (await queryOne<{ root_path: string | null }>('SELECT root_path FROM projects WHERE id = $1', [(dbSession as any).projectId]))?.root_path ?? undefined
      : undefined);

  // Compute project-based accessible paths (cached, ~0ms on hit) BEFORE the race
  // re-check below, so there is no `await` between that re-check and engine.run()
  // — making the check-and-start atomic (no other handleChat can interleave).
  let accessiblePaths: string[] | null | undefined;
  if (client.userId) {
    try {
      const { getUserAccessiblePaths } = await import('../services/pm/project-access.js');
      accessiblePaths = await getUserAccessiblePaths(client.userId, client.userRole || 'member');
    } catch (err: any) {
      accessiblePaths = accessiblePathsFallbackForRole(client.userRole);
      console.warn(`[ws] getUserAccessiblePaths failed (${accessiblePaths === null ? 'privileged fallback' : 'failing closed'}): ${err?.message || err}`);
    }
  }

  let maintenanceGrant: any = null;
  if (client.userId && (client.userRole === 'admin' || client.userRole === 'operator')) {
    try {
      const { resolveActiveMaintenanceToolGrant } = await import('../services/pm/cross-project-maintenance.js');
      maintenanceGrant = await resolveActiveMaintenanceToolGrant({
        actorUserId: client.userId,
        sourceSessionId: sessionId,
      });
      if (maintenanceGrant) {
        console.log(`[ws] cross-project maintenance grant active: ${maintenanceGrant.id} mode=${maintenanceGrant.mode} roots=${maintenanceGrant.projectRoots.length}`);
      }
    } catch (err: any) {
      console.warn(`[ws] resolveActiveMaintenanceToolGrant failed: ${err?.message || err}`);
    }
  }

  // Race guard: the `engine.isRunning` gate at the top of handleChat passed
  // (engine idle), but several awaits happened since (saveMessage, accessible
  // paths, context injection). A near-simultaneous message — common now that the
  // UI encourages rapid mid-turn sends (issue #17) — may have started a turn in
  // that window. Re-check synchronously here; with no `await` left before run(),
  // the check-and-start is atomic. If a turn is now active, fold this message
  // into it as a mid-turn injection instead of calling run() again (which would
  // yield a scary "Pi session is already running" error). The message was
  // already saved + broadcast above, so it stays visible. Placed BEFORE the
  // try/finally so the early return does not trigger the finally's idle
  // broadcast (the active turn is still streaming).
  if (engine.isRunning(sessionId)) {
    if (engineName === 'pi' && typeof engine.steer === 'function') {
      try {
        await engine.steer(sessionId, finalMessage, userMsgId, client.username || null);
        console.log(`[ws] handleChat folded into steer (start race) session=${sessionId.slice(0, 8)} msgId=${userMsgId.slice(0, 8)}`);
        releaseLock();
        return;
      } catch (err: any) {
        console.warn(`[ws] start-race steer failed; enqueueing: ${err?.message || err}`);
      }
    }
    enqueuePendingUserMessage(sessionId, { client, data: { ...data, messageId: userMsgId } });
    sendToClient(client, sessionId, {
      type: 'user_message_queued',
      sessionId,
      messageId: userMsgId,
      message: '메시지 큐에 추가됨. 현재 응답이 끝나면 자동으로 처리됩니다.',
    });
    releaseLock();
    return;
  }

  // Critical section done — the turn is about to start. Release the lock so the
  // next queued message can be processed (and steered into this turn) while the
  // long-running loop below proceeds. (finally also releases as a safety net.)
  releaseLock();

  const turnSystemPromptFragments: SystemPromptFragmentKey[] = selectSystemPromptFragmentsForMessage(finalMessage);
  if (data.voiceMode && !turnSystemPromptFragments.includes('voice-spoken-korean')) {
    turnSystemPromptFragments.push('voice-spoken-korean');
  }

  const runOpts = {
    cwd: runCwd,
    model: resolvedModel,
    effort: data.effort,
    userId: client.userId,
    username: client.username,
    userRole: client.userRole,
    rootTurnId: userMsgId,
    acceptedAt,
    allowedPath: client.allowedPath,
    accessiblePaths,
    maintenanceGrant,
    engineSessionId,
    projectId: (dbSession as any)?.projectId || undefined,
    sessionProjectRoot,
    systemPromptFragments: turnSystemPromptFragments,
  };

  if (parsedSlash?.command.dispatch.type === 'workflow' && parsedSlash.command.dispatch.target === 'agent') {
    const rawArgs = parsedSlash.args.trim();
    const [agentId = '', ...taskParts] = rawArgs.split(/\s+/).filter(Boolean);
    const definitions = loadProjectAgentDefinitions(sessionProjectRoot || runCwd);

    if (!agentId) {
      const summary = definitions.length > 0
        ? `Agents 패널을 열었습니다. 사용 가능한 에이전트 ${definitions.length}개를 확인할 수 있습니다.`
        : 'Agents 패널을 열었습니다. 아직 이 프로젝트에 설정된 에이전트는 없습니다.';
      sendToClient(client, sessionId, {
        type: 'command_executed',
        sessionId,
        commandId: parsedSlash.command.id,
        message: summary,
        uiAction: parsedSlash.command.uiAction,
      });
      await appendCommandProcessEvent('completed');
      return;
    }

    const definition = findProjectAgentDefinition(sessionProjectRoot || runCwd, agentId);
    if (!definition) {
      sendToClient(client, sessionId, {
        type: 'command_executed',
        sessionId,
        commandId: parsedSlash.command.id,
        message: `에이전트 "${agentId}"를 찾지 못했습니다. /agent 로 목록을 확인하세요.`,
      });
      await appendCommandProcessEvent('failed', `Agent definition not found: ${agentId}`);
      return;
    }

    const task = taskParts.join(' ').trim();
    if (!task) {
      sendToClient(client, sessionId, {
        type: 'command_executed',
        sessionId,
        commandId: parsedSlash.command.id,
        message: `실행할 일을 함께 적어주세요. 예: /agent ${definition.id} 이번 변경사항 리뷰해줘`,
      });
      await appendCommandProcessEvent('failed', 'Missing agent task');
      return;
    }
    if (!client.userId) {
      broadcastToSession(sessionId, { type: 'error', message: '로그인 사용자만 /agent를 실행할 수 있습니다.', errorCode: 'COMMAND_UNAUTHORIZED', sessionId });
      await appendCommandProcessEvent('failed', 'COMMAND_UNAUTHORIZED');
      return;
    }

    const workerName = definition.displayName || definition.id;
    const instruction = [
      definition.instruction,
      '',
      'Definition metadata:',
      `- id: ${definition.id}`,
      definition.permissions ? `- permissions: ${JSON.stringify(definition.permissions)}` : null,
      definition.report ? `- report: ${JSON.stringify(definition.report)}` : null,
    ].filter((line): line is string => !!line).join('\n');

    try {
      const { createPersistentWorker, sendWorker } = await import('../services/agent-workers.js');
      let launched;
      try {
        launched = await sendWorker({
          callerSessionId: sessionId,
          callerSessionName: dbSession?.name || 'Tower Session',
          callerUserId: client.userId,
          callerRole: client.userRole || 'member',
          workerIdOrName: workerName,
          message: task,
          onComplete: 'wake',
          agentDefinitionId: definition.id,
        });
      } catch (err: any) {
        if (err?.code !== 'WORKER_NOT_FOUND') throw err;
        launched = await createPersistentWorker({
          parentSessionId: sessionId,
          ownerUserId: client.userId,
          parentUsername: client.username,
          parentRole: client.userRole || 'member',
          name: workerName,
          role: definition.role,
          instruction,
          face: definition.face,
          tagline: definition.tagline,
          goal: definition.goal || definition.role,
          task,
          visibility: definition.visibility,
          engine: definition.engine,
          model: definition.model,
          modelPolicy: definition.modelPolicy,
          effort: definition.effort,
          onComplete: 'wake',
          agentDefinitionId: definition.id,
          agentDefinitionSourcePath: definition.sourcePath,
        });
      }

      sendToClient(client, sessionId, {
        type: 'command_executed',
        sessionId,
        commandId: parsedSlash.command.id,
        message: `${workerName} 에이전트를 실행했습니다. 결과가 준비되면 이 세션에 보고됩니다.`,
        workerId: launched.workerId,
        backingSessionId: launched.sessionId,
        runId: launched.runId,
      });
      await appendCommandProcessEvent('completed');
    } catch (err: any) {
      broadcastToSession(sessionId, { type: 'error', message: err?.message || 'Agent command failed', errorCode: err?.code || 'AGENT_COMMAND_FAILED', sessionId });
      await appendCommandProcessEvent('failed', err?.message || 'Agent command failed');
    }
    return;
  }

  // Native /compact is Pi-only now. It bypasses the LLM prompt path and calls
  // the session compactor directly, while still forwarding Tower compact events
  // through the same websocket/DB marker pipeline.
  if (parsedSlash?.command.dispatch.type === 'native' && parsedSlash.command.dispatch.target === 'session.compact') {
    if (typeof engine.compact !== 'function') {
      broadcastToSession(sessionId, { type: 'error', message: '이 엔진은 /compact를 지원하지 않습니다.', errorCode: 'COMMAND_UNSUPPORTED', sessionId });
      await appendCommandProcessEvent('failed', 'COMMAND_UNSUPPORTED');
      return;
    }
    broadcastToAll({ type: 'session_status', sessionId, status: 'streaming' });
    try {
      resetHangTimer();
      for await (const towerMsg of engine.compact(sessionId, runOpts, callbacks, parsedSlash.args || undefined)) {
        resetHangTimer();
        broadcastTowerMessage(sessionId, towerMsg);
        const terminalMsg = towerToLegacyTerminal(towerMsg, sessionId);
        if (terminalMsg) broadcastToSession(sessionId, terminalMsg);
        if (towerMsg.type === 'engine_done') {
          const esid = towerMsg.engineSessionId;
          if (client.sessionId === sessionId && esid) {
            client.engineSessionId = esid;
            try { await claimActiveEngineSessionId(sessionId, engineName, esid); } catch {}
          }
        }
      }
      sendToClient(client, sessionId, {
        type: 'command_executed',
        sessionId,
        commandId: parsedSlash.command.id,
        message: '컨텍스트를 압축했습니다.',
      });
      await appendCommandProcessEvent('completed');
    } catch (error: any) {
      broadcastToSession(sessionId, { type: 'error', message: error?.message || 'Compact failed', errorCode: 'COMPACT_FAILED', sessionId });
      await appendCommandProcessEvent('failed', error?.message || 'Compact failed');
    } finally {
      if (hangTimer) clearTimeout(hangTimer);
      broadcastToAll({ type: 'session_status', sessionId, status: 'idle' });
    }
    return;
  }

  // The backend owns the authoritative wall-clock boundary. Keep it in the
  // running registry so reconnect/session-switch snapshots never restart at 0.
  const turnTiming: ActiveTurnTiming = { rootTurnId: userMsgId, acceptedAt };
  activeTurnTimings.set(sessionId, turnTiming);

  // Notify all clients that this session started streaming.
  broadcastToAll({
    type: 'session_status',
    sessionId,
    status: 'streaming',
    turnTiming,
    serverNow: new Date().toISOString(),
  });

  let skillCompletionEventAppended = false;
  let commandCompletionEventAppended = false;
  let engineDoneSeen = false;
  try {
    resetHangTimer();

    for await (const towerMsg of engine.run(sessionId, finalMessage, runOpts, callbacks)) {
      resetHangTimer();

      // Primary path: frontend consumes TowerMessage directly for
      // assistant / turn_done / compact content.
      const outboundTowerMsg = towerMsg.type === 'assistant' && activeSkillInvocation
        ? {
            ...towerMsg,
            metadata: mergeSkillInvocationMetadata(((towerMsg as any).metadata || {}), activeSkillInvocation),
          }
        : towerMsg;
      broadcastTowerMessage(sessionId, outboundTowerMsg);

      // Terminal legacy frames (sdk_done / error / resume_failed) still
      // flow as before — the frontend has richer handlers for those
      // (auto-name on sdk_done, error-code routing on error).
      const terminalMsg = towerToLegacyTerminal(towerMsg, sessionId);
      if (terminalMsg) {
        broadcastToSession(sessionId, terminalMsg);
      }

      if (towerMsg.type === 'turn_done' && Array.isArray((towerMsg as any).assistantMsgIds)) {
        try { await touchMessages((towerMsg as any).assistantMsgIds); } catch {}
      }

      // Update session metadata on engine_done
      if (towerMsg.type === 'engine_done') {
        engineDoneSeen = true;
        const esid = towerMsg.engineSessionId;
        const stopMode = rootTurnStopModes.get(userMsgId);
        if (stopMode) {
          rootTurnStopModes.delete(userMsgId);
          await settleAgentTurnStop({ rootTurnId: userMsgId, mode: stopMode }).catch(() => {});
          broadcastToSession(sessionId, {
            type: 'turn_stop_state', sessionId, rootTurnId: userMsgId,
            state: stopMode === 'safe' ? 'stopped_clean' : 'stopped_forced', mode: stopMode,
          });
        }
        const terminalDecision = decideTurnTerminal({
          sessionId,
          rootTurnId: userMsgId,
          engineOutcome: towerMsg.outcome,
          assistantMessageId: towerMsg.assistantMessageId,
          stopMode,
          error: towerMsg.error,
        });
        // Root-turn terminal facts affect sidebar attention across sessions, tabs,
        // and backend processes. Broadcast once through the ACL-filtered global
        // channel; session_status remains activity-only.
        broadcastToAll(toTurnTerminalMessage(terminalDecision));

        if (terminalDecision && !stopMode) {
          try {
            await markAgentTurnCheckpoint(userMsgId, {
              status: terminalDecision.outcome === 'completed'
                ? 'completed'
                : terminalDecision.outcome === 'waiting_retry'
                  ? 'waiting_retry'
                  : 'needs_attention',
              sessionId,
              engine: engineName,
              model: towerMsg.model || data.model || null,
              engineSessionId: esid || engineSessionId || null,
              error: terminalDecision.outcome === 'completed' ? null : terminalDecision.error,
            });
          } catch (err) {
            console.warn(`[ws] agent turn checkpoint terminal update failed for ${sessionId.slice(0, 8)}:`, err);
          }
        }
        if (client.sessionId === sessionId && esid) {
          client.engineSessionId = esid;
          // Persist to the active engine's resume column so sessions survive restart.
          try { await claimActiveEngineSessionId(sessionId, engineName, esid); } catch {}
        }
        const completedForSideEffects = terminalDecision.outcome === 'completed';
        if (completedForSideEffects && activeSkillInvocation && !skillCompletionEventAppended) {
          try {
            await appendProcessEvent(skillInvocationProcessEventParams({
              projectId: (dbSession as any)?.projectId ?? null,
              sessionId,
              invocation: activeSkillInvocation,
              phase: 'completed',
            }));
            skillCompletionEventAppended = true;
          } catch (err: any) {
            console.warn('[ws] append skill_invocation completed event failed:', err?.message || err);
          }
        }
        if (completedForSideEffects && activeCommandInvocation && !commandCompletionEventAppended) {
          await appendCommandProcessEvent('completed');
          commandCompletionEventAppended = true;
        }
        // Update turn_count, files_edited in DB + server-side auto-name
        try {
          const currentSession = await getSession(sessionId);
          if (currentSession) {
            const newTurnCount = (currentSession.turnCount ?? 0) + 1;
            const existingFiles: string[] = currentSession.filesEdited || [];
            const newFiles = towerMsg.editedFiles || [];
            const mergedFiles = [...new Set([...existingFiles, ...newFiles])];
            // Engine-mismatch guard: NEVER write a model_used that doesn't match
            // the session's engine. Previously `modelUsed: towerMsg.model || data.model`
            // would fall through to `data.model` (the frontend-sent model) when
            // towerMsg.model was empty — which is exactly how a Pi session ended up
            // with model_used="claude-sonnet-4-6" (panel inherited global selectedModel).
            // 결정: workspace/decisions/2026-05-17-pi-panel-session-model-used-bug.md
            const candidateModel = towerMsg.model || data.model;
            const isModelCompatibleWithEngine =
              !!candidateModel && (
                engineName === 'claude' ? candidateModel.startsWith('claude-')
                : engineName === 'pi' ? candidateModel.includes('/')
                : true // local: accept anything else
              );
            const updates: any = {
              turnCount: newTurnCount,
              filesEdited: mergedFiles,
            };
            if (isModelCompatibleWithEngine) {
              updates.modelUsed = candidateModel;
            } else if (candidateModel) {
              console.log(`[ws] engine_done: skipping modelUsed update — "${candidateModel}" does not match engine="${engineName}"`);
            }
            await updateSession(sessionId, updates);

            // A normal chat turn previously ended only as a WS engine_done frame,
            // so browser/PWA subscribers never received the configured
            // session.completed event. Delivery remains policy-controlled and
            // best-effort: disabled users create no notification, and push failure
            // must never delay or fail the completed AI turn.
            if (completedForSideEffects && client.userId) {
              void notify(
                client.userId,
                currentSession.roomId ?? null,
                'session.completed',
                'AI 답변이 끝났습니다',
                currentSession.name || 'Tower 세션',
                {
                  sessionId,
                  projectId: currentSession.projectId ?? null,
                  actionUrl: `/s/${currentSession.shortCode || sessionId}`,
                },
                {
                  sessionId,
                  projectId: currentSession.projectId ?? null,
                  actionUrl: `/s/${currentSession.shortCode || sessionId}`,
                },
              ).catch((err: any) => {
                console.warn(`[ws] session completion notification failed session=${sessionId.slice(0, 8)}:`, err?.message || err);
              });
            }

            // Session continuity card — background refresh, never blocks the user turn.
            try {
              const { scheduleSessionMemoryCardRefresh } = await import('../services/ai/session-memory-card.js');
              scheduleSessionMemoryCardRefresh(sessionId);
            } catch {}

            // Server-side auto-name (helper — mirrored in auto-resume path).
            await tryAutoNameSession(sessionId);
          }
        } catch {}
      }
    }
  } catch (error: any) {
    // ── 0b (2026-05-15): persist full error context to ~/workspace/.audit/pi-errors.jsonl ──
    // Previous behavior dropped error.stack/cause/code, leaving us with just
    // "Unknown error (no error details in response)" with no way to diagnose.
    // Now we record full context to a structured jsonl that mirrors provenance.jsonl,
    // so the next mid-stream failure is fully recoverable for postmortem.
    // Per workspace/decisions/2026-05-15-pi-mitigation-rollback.md (TBD).
    const errorRecord = {
      ts: new Date().toISOString(),
      sessionId,
      engine: engineName,
      model: (dbSession as any)?.model_used || data.model || null,
      userId: client.userId || null,
      message: error?.message || String(error) || null,
      name: error?.name || null,
      code: error?.code || null,
      stack: error?.stack ? String(error.stack).slice(0, 4000) : null,
      cause: error?.cause ? String(error.cause).slice(0, 1000) : null,
    };
    if (engineName === 'pi' && !engineDoneSeen) {
      try {
        await markAgentTurnCheckpoint(userMsgId, {
          status: 'failed',
          sessionId,
          engine: engineName,
          model: data.model || null,
          engineSessionId: engineSessionId || null,
          error: error?.message || String(error),
        });
      } catch (checkpointErr) {
        console.warn(`[ws] agent turn checkpoint failed-state update failed for ${sessionId.slice(0, 8)}:`, checkpointErr);
      }
    }
    console.error(`[ws] handleChat ERROR session=${sessionId}:`, error.message || error);
    if (error?.stack) console.error(error.stack.slice(0, 2000));
    try {
      const fs = await import('fs');
      const path = await import('path');
      const auditDir = path.join(process.env.HOME || '/home/tower', 'workspace', '.audit');
      fs.mkdirSync(auditDir, { recursive: true });
      fs.appendFileSync(path.join(auditDir, 'pi-errors.jsonl'), JSON.stringify(errorRecord) + '\n');
    } catch (auditErr: any) {
      console.warn(`[ws] failed to persist pi-errors.jsonl: ${auditErr?.message || auditErr}`);
    }
    if (activeCommandInvocation && !commandCompletionEventAppended) {
      await appendCommandProcessEvent('failed', error?.message || String(error));
      commandCompletionEventAppended = true;
    }
    if (activeSkillInvocation) {
      try {
        await appendProcessEvent(skillInvocationProcessEventParams({
          projectId: (dbSession as any)?.projectId ?? null,
          sessionId,
          invocation: activeSkillInvocation,
          phase: 'failed',
          error: error?.message || String(error),
        }));
      } catch (eventErr: any) {
        console.warn('[ws] append skill_invocation failed event failed:', eventErr?.message || eventErr);
      }
    }
    broadcastToSession(sessionId, {
      type: 'error',
      message: error.message || 'Engine query failed',
      sessionId,
      // Echo a short stack snippet to the client so DevTools console shows the cause
      stackPreview: error?.stack ? String(error.stack).slice(0, 800) : undefined,
    });
  } finally {
    console.log(`[ws] handleChat END session=${sessionId.slice(0, 8)} engine=${engineName}`);
    if (hangTimer) clearTimeout(hangTimer);
    // Same-text retry state is short-lived and capped (3 attempts) so users can
    // intentionally re-inject after interruptions without reopening replay storms.
    if (reservedTextDedupeKey) {
      const textState = recentUserInputTextAttempts.get(reservedTextDedupeKey);
      if (textState && textState.expiresAt <= Date.now()) {
        recentUserInputTextAttempts.delete(reservedTextDedupeKey);
      }
    }
    releaseLock(); // safety net — no-op if already released before the turn loop
    activeTurnTimings.delete(sessionId);
    broadcastToAll({
      type: 'session_status',
      sessionId,
      status: 'idle',
      turnTiming: null,
      serverNow: new Date().toISOString(),
    });
  }
}

function handleAnswerQuestion(client: WsClient, data: { questionId: string; answer: string; sessionId?: string }) {
  const sessionId = data.sessionId || client.sessionId;
  const activeRootTurnId = sessionId ? activeTurnTimings.get(sessionId)?.rootTurnId : undefined;
  if (activeRootTurnId) void setAgentTurnWaitingUser(activeRootTurnId, false).catch(() => {});
  if (sessionId) {
    broadcastToAll({ type: 'session_awaiting_user', sessionId, awaiting: false });
  }
  if (resolvePendingQuestionLocally(data.questionId, data.answer, sessionId)) {
    if (sessionId) {
      remotePendingQuestionsBySession.delete(sessionId);
    }
    return;
  }

  if (!sessionId || !isPgEnabled()) return;

  remotePendingQuestionsBySession.delete(sessionId);
  publishWsSyncEvent(config.serverEpoch, {
    scope: 'session',
    sessionId,
    data: {
      type: 'answer_question_sync',
      questionId: data.questionId,
      answer: data.answer,
    },
  });
}

async function handleTurnStopRequest(client: WsClient, data: { sessionId?: string; mode?: 'safe' | 'force' }) {
  const sessionId = data.sessionId || client.sessionId;
  if (!sessionId) return;

  if (typeof client.userId !== 'number') {
    sendToClient(client, sessionId, { type: 'turn_stop_state', sessionId, state: 'rejected', reason: 'auth_required' });
    return;
  }
  const access = await canAccessSession(sessionId, client.userId, client.userRole || 'member');
  if (!access.allowed) {
    sendToClient(client, sessionId, { type: 'turn_stop_state', sessionId, state: 'rejected', reason: access.message || 'forbidden' });
    return;
  }

  const session = await getSession(sessionId);
  if (!session || session.engine !== 'pi') {
    sendToClient(client, sessionId, { type: 'turn_stop_state', sessionId, state: 'rejected', reason: 'pi_session_required' });
    return;
  }
  const engine = await getEngine('pi');
  const rootTurnId = activeTurnTimings.get(sessionId)?.rootTurnId;
  const mode = data.mode === 'force' ? 'force' : 'safe';
  if (!rootTurnId) {
    sendToClient(client, sessionId, { type: 'turn_stop_state', sessionId, state: 'rejected', reason: 'no_active_turn' });
    return;
  }

  rootTurnStopModes.set(rootTurnId, mode);
  const persisted = await requestAgentTurnStop({ rootTurnId, mode }).catch(() => false);
  if (!persisted) {
    rootTurnStopModes.delete(rootTurnId);
    sendToClient(client, sessionId, { type: 'turn_stop_state', sessionId, rootTurnId, state: 'rejected', reason: 'turn_not_stoppable' });
    return;
  }

  if (mode === 'force') {
    await abortSessionEverywhere(sessionId);
    await settleAgentTurnStop({ rootTurnId, mode: 'force' }).catch(() => {});
    rootTurnStopModes.delete(rootTurnId);
    broadcastToSession(sessionId, { type: 'turn_stop_state', sessionId, rootTurnId, state: 'stopped_forced', mode: 'force' });
    return;
  }

  if (typeof engine.requestStopAtBoundary !== 'function') {
    rootTurnStopModes.delete(rootTurnId);
    await rejectAgentTurnStopRequest({ rootTurnId, error: 'Pi safe-stop capability is unavailable.' }).catch(() => {});
    sendToClient(client, sessionId, { type: 'turn_stop_state', sessionId, rootTurnId, state: 'rejected', reason: 'safe_stop_unavailable' });
    return;
  }

  const result = await engine.requestStopAtBoundary(sessionId);
  if (!result.accepted) {
    rootTurnStopModes.delete(rootTurnId);
    await rejectAgentTurnStopRequest({ rootTurnId, error: result.reason || 'Safe stop request was not accepted.' }).catch(() => {});
    sendToClient(client, sessionId, { type: 'turn_stop_state', sessionId, rootTurnId, state: 'rejected', reason: result.reason || 'not_running' });
    return;
  }
  broadcastToSession(sessionId, {
    type: 'turn_stop_state', sessionId, rootTurnId, state: 'boundary_wait', mode: 'safe', waitingFor: result.waitingFor,
  });
}

async function handleAbort(client: WsClient, data: { sessionId?: string }) {
  const sessionId = data.sessionId || client.sessionId;
  if (sessionId) {
    console.log(`[ws] handleAbort session=${sessionId} client=${client.id}`);
    cancelPendingQuestionsForSession(sessionId, 'Session aborted');
    pendingUserAbortCooldownUntil.set(sessionId, Date.now() + PENDING_USER_ABORT_COOLDOWN_MS);
    clearPendingUserMessages(sessionId, 'abort');
    // Resolve engine and abort
    await abortSessionEverywhere(sessionId);
    if (isPgEnabled()) {
      publishWsSyncEvent(config.serverEpoch, {
        scope: 'session',
        sessionId,
        data: { type: 'abort_session_sync' },
      });
    }
    clearRemoteStreamingSession(sessionId);
    // Pure: bump epoch + remove this client from session routing
    abortCleanup(client, sessionClients, sessionId);
    send(client.ws, { type: 'abort_result', aborted: true, sessionId });
  }
}

async function handleFileRead(client: WsClient, data: { path: string }) {
  try {
    // Expand `~/...` so AI-emitted portable paths resolve. All downstream
    // safety checks (dotfile, allowedPath, isPathAccessible, readFile) run on
    // the expanded value — this does not widen access.
    // Decision: workspace/decisions/2026-05-03-path-portability.md
    const filePath = expandHome(data.path);
    // 2026-05-02: dotfile/system path always blocked
    if (isDotfileDenied(filePath)) {
      send(client.ws, { type: 'error', message: 'Access denied: system path' });
      return;
    }
    if (client.allowedPath && !isPathSafe(filePath, client.allowedPath)) {
      send(client.ws, { type: 'error', message: 'Access denied: outside allowed path' });
      return;
    }
    // Project-level path check (same as HTTP /files/read)
    if (client.userId) {
      const pathOk = await isPathAccessible(filePath, client.userId, client.userRole || 'member');
      if (!pathOk) {
        send(client.ws, { type: 'error', message: 'Access denied: project path' });
        return;
      }
    }
    // Binary files (PDF, images): send metadata only — frontend fetches via HTTP API
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const binaryExts = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'mp4', 'm4v', 'mov', 'webm', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'hwp', 'hwpx', 'db', 'sqlite', 'sqlite3', 'dxf', 'dwg']);
    if (binaryExts.has(ext)) {
      const langMap: Record<string, string> = { pdf: 'pdf', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image', mp4: 'video', m4v: 'video', mov: 'video', webm: 'video', docx: 'docx', doc: 'docx', xlsx: 'xlsx', xls: 'xlsx', pptx: 'pptx', ppt: 'pptx', hwp: 'hwp', hwpx: 'hwp', db: 'sqlite', sqlite: 'sqlite', sqlite3: 'sqlite', dxf: 'cad', dwg: 'cad' };
      console.log(`[ws] binary file detected: ${filePath} (${ext})`);
      send(client.ws, {
        type: 'file_content',
        path: filePath,
        content: '',
        language: langMap[ext] || 'binary',
        encoding: 'binary',
      });
      return;
    }
    const result = readFile(filePath);
    send(client.ws, {
      type: 'file_content',
      path: filePath,
      content: result.content,
      language: result.language,
    });
  } catch (error: any) {
    send(client.ws, { type: 'error', message: error.message });
  }
}

async function handleFileWrite(client: WsClient, data: { path: string; content: string }) {
  try {
    // 2026-05-02: dotfile/system path always blocked
    if (isDotfileDenied(data.path)) {
      send(client.ws, { type: 'error', message: 'Access denied: system path' });
      return;
    }
    if (client.allowedPath && !isPathSafe(data.path, client.allowedPath)) {
      send(client.ws, { type: 'error', message: 'Access denied: outside allowed path' });
      return;
    }
    // Project-level path check (same as HTTP /files/write) + role-based write check
    if (client.userId) {
      const pathOk = await isPathAccessible(data.path, client.userId, client.userRole || 'member');
      if (!pathOk) {
        send(client.ws, { type: 'error', message: 'Access denied: project path' });
        return;
      }
      // 2026-05-02: role-based write policy (read-only for member in docs/decisions)
      const { isPathWritableByRole } = await import('../services/pm/project-access.js');
      const writeOk = await isPathWritableByRole(data.path, client.userId, client.userRole || 'member');
      if (!writeOk) {
        send(client.ws, { type: 'error', message: 'Access denied: this folder is read-only for your role' });
        return;
      }
    }
    writeFile(data.path, data.content);
    send(client.ws, {
      type: 'file_saved',
      path: data.path,
    });
  } catch (error: any) {
    send(client.ws, { type: 'error', message: error.message });
  }
}

async function handleFileTree(client: WsClient, data: { path?: string; showHidden?: boolean }) {
  try {
    const securityRoot = client.allowedPath || config.workspaceRoot;
    // Privileged (admin/operator) default to workspace root; others to their allowed path
    const defaultRoot = isPrivilegedRole(client.userRole) ? config.workspaceRoot : securityRoot;
    const targetPath = data.path || defaultRoot;

    // 2026-05-02: dotfile/system path always blocked
    if (isDotfileDenied(targetPath)) {
      send(client.ws, { type: 'error', message: 'Access denied: system path' });
      return;
    }

    if (!isPathSafe(targetPath, securityRoot)) {
      send(client.ws, { type: 'error', message: 'Access denied: outside allowed path' });
      return;
    }

    // 2026-05-02: non-privileged users may not browse arbitrary directories
    // outside their accessible-paths set (mirrors HTTP /files/tree).
    //
    // 2026-05-06: do NOT surface this as a user-facing 'error' toast and do
    // NOT respond with an empty file_tree either. The most common trigger is
    // the implicit default request fired on every WS (re)connect
    // (useClaudeChat.ts:359) with no `path` set — for members without an
    // explicit `allowed_path`, defaultRoot resolves to the workspace root,
    // which they can't list. Sending a `file_tree` response (even empty)
    // makes the frontend's case 'file_tree' handler call setTree([]), which
    // wipes the sidebar's project sections. The frontend's auto file_tree
    // request is fire-and-forget — silently dropping the request is correct.
    // Genuine path-traversal attempts are still caught by the isPathSafe
    // branch above.
    if (client.userId && !isPrivilegedRole(client.userRole)
        && !(await isPathAccessible(targetPath, client.userId, client.userRole || 'member'))) {
      return;
    }

    // showHidden is allowed inside already-authorized paths for all roles.
    // ALWAYS_HIDDEN/system paths are still filtered by getFileTree and
    // isDotfileDenied, so project members can inspect project-local dotfiles
    // without exposing credentials/runtime state.
    const showHidden = !!data.showHidden;
    const entries = getFileTree(targetPath, 2, { showHidden });
    send(client.ws, {
      type: 'file_tree',
      path: targetPath,
      entries,
    });
  } catch (error: any) {
    send(client.ws, { type: 'error', message: error.message });
  }
}

/**
 * Broadcast a message to ALL clients of a specific user (by userId).
 * Used for member-added notifications so the invited user sees the room immediately.
 */
export function broadcastToUser(userId: number, data: any) {
  localBroadcastToUser(userId, data);
  if (!isPgEnabled()) return;
  publishWsSyncEvent(config.serverEpoch, { scope: 'user', userId, data });
}

/**
 * Forward a successful present_file result to every browser owned by the invoking user.
 * Session-scoped tool frames are intentionally dropped by inactive chat views, while the
 * Viewer tab set is user/browser-scoped and must still retain the presented file quietly.
 */
function broadcastPresentFileIntent(userId: number | undefined, sessionId: string, deliveryId: string, result: unknown): void {
  if (!userId || typeof result !== 'string') return;
  try {
    const parsed = JSON.parse(result);
    if (parsed?.ok !== true || parsed?.action !== 'present_file' || typeof parsed.path !== 'string') return;
    broadcastToUser(userId, {
      type: 'present_file_intent',
      sessionId,
      deliveryId,
      path: parsed.path,
      label: typeof parsed.label === 'string' ? parsed.label : undefined,
      focus: parsed.focus !== false,
    });
  } catch {
    // Non-JSON and error tool results are not presentation intents.
  }
}

export { broadcastToRoom, broadcastToSession };

/**
 * Server-side auto-resume for interrupted sessions.
 * Called once at startup — resumes sessions that were streaming when the server shut down,
 * WITHOUT waiting for a client WebSocket reconnect.
 *
 * This fixes the gap where background-only sessions (or sessions with no active browser tab)
 * would be permanently lost because no client ever sent a `reconnect` message for them.
 */
function modelMatchesEngineForAutoResume(model: string | undefined, engineName: string): boolean {
  if (!model) return false;
  if (engineName === 'claude') return model.startsWith('claude-');
  if (engineName === 'pi') return model.includes('/');
  if (engineName === 'local') {
    const localModelIds = new Set((config.localModels || []).map((m: any) => String(m.id).replace(/^local:/, '')));
    return !model.startsWith('claude-') && !model.includes('/') && (localModelIds.size === 0 || localModelIds.has(model));
  }
  return false;
}

function resolveAutoResumeModel(dbSession: Awaited<ReturnType<typeof getSession>>, engineName: string): string | undefined {
  const storedModel = ((dbSession as any)?.modelUsed || (dbSession as any)?.model_used) as string | undefined;
  if (engineName === 'pi') return normalizePiSessionModelId(storedModel);
  if (modelMatchesEngineForAutoResume(storedModel, engineName)) return storedModel;
  return undefined;
}

const AUTO_RESUME_MAX_ATTEMPTS = 4;
const AUTO_RESUME_RETRY_DELAY_MS = 5000;
const PI_AUTO_RESUME_MAX_SESSION_FILE_BYTES = 128 * 1024 * 1024;
const autoResumeSessionsInFlight = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function summarizeAutoResumeMessageCounts(counts: { assistant: number; engineDone: number; engineError: number; saved: number }): string {
  return `assistant=${counts.assistant} engine_done=${counts.engineDone} engine_error=${counts.engineError} saved=${counts.saved}`;
}

function getPiAutoResumeSessionFileSize(engineName: string, engineSessionId: string | undefined): number | undefined {
  if (engineName !== 'pi' || !engineSessionId || !engineSessionId.startsWith('/')) return undefined;
  try {
    return fs.statSync(engineSessionId).size;
  } catch {
    return undefined;
  }
}

type InterruptedTurnDetail = { id: string; claudeSessionId?: string; userMessageId?: string; recoverySource?: string };

async function rootTurnAlreadyHasTerminalAssistantText(sessionId: string, rootTurnId: string): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    `WITH root_user AS (
       SELECT created_at FROM messages WHERE id = $2 AND session_id = $1 AND role = 'user'
     )
     SELECT EXISTS (
       SELECT 1
       FROM messages a, root_user r
       WHERE a.session_id = $1
         AND a.role = 'assistant'
         AND a.completed_at IS NOT NULL
         AND a.created_at > r.created_at
         AND NOT EXISTS (
           SELECT 1 FROM messages newer_user
           WHERE newer_user.session_id = $1
             AND newer_user.role = 'user'
             AND newer_user.created_at > r.created_at
             AND newer_user.created_at < a.created_at
         )
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(a.content::jsonb) block
           WHERE block->>'type' = 'text'
             AND length(btrim(COALESCE(block->>'text', ''))) > 0
         )
     ) AS exists`,
    [sessionId, rootTurnId],
  );
  return Boolean(row?.exists);
}

/** Run the same recovery path for startup discoveries and durable delayed retries. */
async function resumeInterruptedDetails(rawDetails: InterruptedTurnDetail[]) {
  if (rawDetails.length === 0) return;
  const details = [...new Map(rawDetails.map(detail => [detail.id, detail])).values()];
  console.log(`[auto-resume] START recovered=${rawDetails.length} unique=${details.length}`);

  // Auto-resume should reopen the native Pi session and let Pi's own
  // agent.continue()/retry/compaction lifecycle advance the transcript.
  // Keep the Engine.run() prompt parameter empty so Tower does not inject a
  // synthetic user-like continuation instruction into the model context.
  const AUTO_RESUME_NATIVE_PROMPT = '';

  for (const detail of details) {
    const { id: sessionId, claudeSessionId: savedClaudeSessionId, recoverySource } = detail;
    let userMessageId = detail.userMessageId;
    let recoveredAcceptedAt: string | undefined;
    if (!userMessageId) {
      try {
        const recoverableTurn = await findRecoverableAgentTurnForSession(sessionId);
        userMessageId = recoverableTurn?.message_id;
        recoveredAcceptedAt = recoverableTurn?.created_at;
      } catch (err) {
        console.warn(`[auto-resume] root turn lookup failed for ${sessionId.slice(0, 8)}:`, err);
      }
    }
    if (autoResumeSessionsInFlight.has(sessionId)) {
      console.warn(`[auto-resume] session=${sessionId.slice(0, 8)} duplicate in-flight — skipping`);
      continue;
    }
    autoResumeSessionsInFlight.add(sessionId);
    const counts = { assistant: 0, engineDone: 0, engineError: 0, saved: 0 };
    let started = false;
    let durableRetryScheduled = false;
    // Don't block startup — fire and forget each resume
    (async () => {
      try {
        const dbSession = await getSession(sessionId);
        if (!dbSession) {
          console.log(`[auto-resume] session=${sessionId.slice(0, 8)} not found in DB — skipping`);
          return;
        }

        // Consume from the client-side set so handleReconnect stops returning 'interrupted'
        const interruptedSet: Set<string> | undefined = (globalThis as any).__interruptedSessions;
        interruptedSet?.delete(sessionId);

        const engineName = (dbSession as any)?.engine || config.defaultEngine || 'claude';
        const autoResumeModel = resolveAutoResumeModel(dbSession, engineName);
        const engine = await getEngine(engineName);

        // Skip if engine is already running for this session (shouldn't happen, but guard)
        if (engine.isRunning(sessionId)) {
          console.log(`[auto-resume] session=${sessionId.slice(0, 8)} already running — skipping`);
          return;
        }

        // Check concurrent limit. A restart can recover several sessions at once;
        // retry briefly instead of silently dropping later sessions.
        for (let attempt = 1; getTotalActiveCount() >= config.maxConcurrentSessions; attempt++) {
          if (attempt >= AUTO_RESUME_MAX_ATTEMPTS) {
            console.warn(`[auto-resume] session=${sessionId.slice(0, 8)} skip reason=concurrent_limit attempts=${attempt} active=${getTotalActiveCount()} max=${config.maxConcurrentSessions}`);
            return;
          }
          console.warn(`[auto-resume] session=${sessionId.slice(0, 8)} retry reason=concurrent_limit attempt=${attempt}/${AUTO_RESUME_MAX_ATTEMPTS} active=${getTotalActiveCount()} max=${config.maxConcurrentSessions}`);
          await sleep(AUTO_RESUME_RETRY_DELAY_MS * attempt);
        }

        const engineSessionId = savedClaudeSessionId || getEngineSessionId(dbSession) || undefined;
        if (!engineSessionId) {
          const error = `Automatic ${engineName} recovery cannot continue because the native engine session identity is missing.`;
          console.warn(`[auto-resume] stop reason=missing_engine_session_id session=${sessionId.slice(0, 8)} engine=${engineName}`);
          if (userMessageId) {
            await markAgentTurnCheckpoint(userMessageId, {
              status: 'needs_attention',
              sessionId,
              engine: engineName,
              model: autoResumeModel || null,
              engineSessionId: null,
              error,
              failureClass: 'missing_engine_session_id',
              forceNeedsAttention: true,
            });
          }
          return;
        }
        if (userMessageId && await rootTurnAlreadyHasTerminalAssistantText(sessionId, userMessageId)) {
          console.log(`[auto-resume] skip reason=terminal_assistant_exists session=${sessionId.slice(0, 8)} root=${userMessageId.slice(0, 8)}`);
          await markAgentTurnCheckpoint(userMessageId, {
            status: 'completed',
            sessionId,
            engine: engineName,
            model: autoResumeModel || null,
            engineSessionId,
            error: null,
          });
          return;
        }

        const piSessionFileSize = getPiAutoResumeSessionFileSize(engineName, engineSessionId);
        if (piSessionFileSize !== undefined && piSessionFileSize > PI_AUTO_RESUME_MAX_SESSION_FILE_BYTES) {
          const error = `Automatic Pi recovery skipped because session file is too large (${Math.round(piSessionFileSize / 1024 / 1024)}MiB > ${Math.round(PI_AUTO_RESUME_MAX_SESSION_FILE_BYTES / 1024 / 1024)}MiB).`;
          console.warn(`[auto-resume] skip reason=pi_session_file_too_large session=${sessionId.slice(0, 8)} bytes=${piSessionFileSize} max=${PI_AUTO_RESUME_MAX_SESSION_FILE_BYTES}`);
          if (userMessageId) {
            await markAgentTurnCheckpoint(userMessageId, {
              status: 'needs_attention',
              sessionId,
              engine: engineName,
              model: autoResumeModel || null,
              engineSessionId,
              error,
              failureClass: 'pi_session_file_too_large',
              forceNeedsAttention: true,
            });
          }
          return;
        }

        started = true;
        console.log(`[auto-resume] resuming session=${sessionId.slice(0, 8)} source=${recoverySource || 'shutdown-file'} engine=${engineName} model=${autoResumeModel || 'engine-default'} engineSid=${engineSessionId?.slice(0, 32)}`);

        // Stamp last_auto_resume_at so the frontend can render a small banner.
        // setLastAutoResumeAt() is intentionally distinct from updateSession()
        // — we don't want server restarts to bump updated_at and reshuffle the
        // sidebar order (the user didn't actually do anything).
        // See: workspace/decisions/2026-05-10-server-resume-prompt-hidden.md
        try {
          await setLastAutoResumeAt(sessionId);
        } catch (err) { console.error('[auto-resume] stamp last_auto_resume_at failed:', err); }

        // Do NOT save a hidden server-resume user message. Recovery is driven by
        // the native Pi session state and Tower root-turn fencing, not by a
        // synthetic continuation instruction persisted or shown as user text.

        // Broadcast streaming status using the original root user-message time.
        const turnTiming: ActiveTurnTiming = {
          rootTurnId: userMessageId || `recovery-${sessionId}`,
          acceptedAt: recoveredAcceptedAt || new Date().toISOString(),
        };
        activeTurnTimings.set(sessionId, turnTiming);
        broadcastToAll({
          type: 'session_status',
          sessionId,
          status: 'streaming',
          turnTiming,
          serverNow: new Date().toISOString(),
        });

        // Fetch user context before creating callbacks. Besides restoring the
        // runtime tool palette, the user id scopes Viewer presentation intents.
        let userId: number | undefined;
        let username: string | undefined;
        let userRole: string | undefined;
        try {
          const userCtx = await queryOne<{
            user_id: number | null;
            username: string | null;
            role: string | null;
          }>(
            `SELECT s.user_id, u.username, u.role
             FROM sessions s LEFT JOIN users u ON s.user_id = u.id
             WHERE s.id = $1`,
            [sessionId]
          );
          if (userCtx?.user_id != null) {
            userId = userCtx.user_id;
            username = userCtx.username || undefined;
            userRole = userCtx.role || undefined;
          }
        } catch (err) {
          console.warn(`[auto-resume] user context fetch failed for ${sessionId.slice(0, 8)}:`, err);
        }

        // Engine callbacks — same as handleChat but without a specific client.
        // AskUserQuestion can still be answered if a user reconnects to this
        // session: store it in the same pendingQuestions map and broadcast to
        // any currently open tabs, rather than auto-answering immediately.
        const callbacks: EngineCallbacks = {
          askUser: (questionId: string, questions: any[]) => {
            const sanitizedQuestions = sanitizeAskUserQuestions(questions);
            if (sanitizedQuestions.length === 0) {
              console.warn(`[auto-resume] ask_user dropped empty payload for session=${sessionId.slice(0, 8)}`);
              return Promise.resolve('No user question payload was provided. Continue without waiting for user input.');
            }

            return new Promise<string>((resolve, reject) => {
              const timer = setTimeout(() => {
                const pq = pendingQuestions.get(questionId);
                if (pq) {
                  pendingQuestions.delete(questionId);
                  if (userMessageId) void setAgentTurnWaitingUser(userMessageId, false).catch(() => {});
                  broadcastToAll({ type: 'session_awaiting_user', sessionId, awaiting: false });
                  broadcastToSession(sessionId, { type: 'ask_user_timeout', sessionId, questionId });
                  const questionSummary = sanitizedQuestions.map((q: any) => q.question).join(', ');
                  resolve(
                    `[System] The user did not respond to the interactive prompt within 60 minutes. ` +
                    `Your question was: "${questionSummary}". ` +
                    `Ask the same question again as a regular chat message if it is still needed.`
                  );
                }
              }, ASK_USER_TIMEOUT);

              if (userMessageId) void setAgentTurnWaitingUser(userMessageId, true).catch(() => {});
              pendingQuestions.set(questionId, {
                questionId,
                sessionId,
                questions: sanitizedQuestions,
                resolve: (answer: string) => {
                  clearTimeout(timer);
                  pendingQuestions.delete(questionId);
                  resolve(answer);
                },
                reject: (error: Error) => {
                  clearTimeout(timer);
                  pendingQuestions.delete(questionId);
                  reject(error);
                },
                timer,
              });

              broadcastToAll({ type: 'session_awaiting_user', sessionId, awaiting: true, questionId });
              broadcastToSession(sessionId, {
                type: 'ask_user',
                sessionId,
                questionId,
                questions: sanitizedQuestions,
              });
            });
          },
          claimSessionId: async (esid: string) => {
            try { await claimActiveEngineSessionId(sessionId, engineName, esid); } catch {}
          },
          saveMessage: async (msg) => {
            counts.saved++;
            try { await saveMessage(sessionId, msg); } catch {}
          },
          updateMessageContent: async (msgId, content) => {
            try { await updateMessageContent(msgId, content); } catch {}
          },
          attachToolResult: async (toolUseId, result) => {
            try { await attachToolResultInDb(sessionId, toolUseId, result); } catch {}
            broadcastPresentFileIntent(userId, sessionId, toolUseId, result);
            broadcastToSession(sessionId, {
              type: 'tool_result_attached',
              sessionId,
              toolUseId,
              result: attachedToolResultForBroadcast(result),
            });
          },
          updateMessageMetrics: async (msgId, metrics) => {
            try {
              await updateMessageMetrics(msgId, {
                duration_ms: metrics.durationMs,
                finalize_completed_at: metrics.finalizeCompletedAt,
                input_tokens: metrics.inputTokens,
                output_tokens: metrics.outputTokens,
                cache_read_tokens: metrics.cacheReadTokens,
                cache_creation_tokens: metrics.cacheCreationTokens,
                reasoning_tokens: metrics.reasoningTokens,
                cache_creation_1h_tokens: metrics.cacheCreation1hTokens,
                cache_creation_5m_tokens: metrics.cacheCreation5mTokens,
                cost_usd: metrics.costUsd,
                context_input_tokens: metrics.contextInputTokens,
                context_window_size: metrics.contextWindowSize,
                context_estimated_tokens: metrics.contextEstimatedTokens,
                next_request_estimated_tokens: metrics.nextRequestEstimatedTokens,
                compact_threshold_tokens: metrics.compactThresholdTokens,
          context_snapshot: metrics.contextSnapshot,
              });
            } catch {}
          },
          recordTraceEvent: async (event) => {
            try {
              await recordAiRunTraceEvent({
                sessionId,
                rootTurnId: userMessageId || null,
                messageId: event.messageId || null,
                projectId: (dbSession as any)?.projectId ?? null,
                actorUserId: userId ?? null,
                engine: engineName,
                model: autoResumeModel || null,
                eventType: event.eventType,
                visibility: event.visibility,
                payload: event.payload,
              });
            } catch (err) {
              console.warn(`[auto-resume] recordTraceEvent failed for ${sessionId.slice(0, 8)}:`, (err as any)?.message || err);
            }
          },
          markCompactBoundary: async (msgId, meta) => {
            try {
              await markCompactBoundary(msgId, meta);
            } catch (err) {
              console.error('[ws] markCompactBoundary (resume) failed:', (err as any)?.message);
            }
          },
        };

        // Hang detection
        let hangTimer: ReturnType<typeof setTimeout> | null = null;
        const resetHangTimer = () => {
          if (hangTimer) clearTimeout(hangTimer);
          hangTimer = setTimeout(() => {
            console.warn(`[auto-resume] session=${sessionId.slice(0, 8)} abort reason=sdk_hang ${summarizeAutoResumeMessageCounts(counts)}`);
            engine.abort(sessionId);
            broadcastToSession(sessionId, {
              type: 'error',
              message: 'SDK response timed out during auto-resume.',
              errorCode: 'SDK_HANG',
              sessionId,
            });
          }, SDK_HANG_TIMEOUT);
        };

        try {
          resetHangTimer();

          for await (const towerMsg of engine.run(sessionId, AUTO_RESUME_NATIVE_PROMPT, {
            cwd: dbSession.cwd || config.defaultCwd,
            engineSessionId,
            projectId: (dbSession as any)?.projectId || undefined,
            model: autoResumeModel,
            userId,
            username,
            userRole,
            rootTurnId: userMessageId,
            acceptedAt: turnTiming.acceptedAt,
            autoResume: true,
            autoResumeReason: 'server-restart',
            // Recovery turns resume an already-assembled engine context. Keep the
            // compact core rather than guessing fragments from the synthetic prompt.
            systemPromptFragments: [],
          }, callbacks)) {
            resetHangTimer();

            if (towerMsg.type === 'assistant') counts.assistant++;
            if (towerMsg.type === 'engine_done') counts.engineDone++;
            if (towerMsg.type === 'engine_error') counts.engineError++;

            // Claim denial means another recovery owner already handles this root turn.
            // Do not downgrade the shared durable state or schedule another retry.
            if (towerMsg.type === 'engine_done' && towerMsg.outcome === 'claim_denied') {
              console.log(`[auto-resume] claim denied session=${sessionId.slice(0, 8)}; another owner is active`);
              continue;
            }

            broadcastTowerMessage(sessionId, towerMsg);
            const terminalMsg = towerToLegacyTerminal(towerMsg, sessionId);
            if (terminalMsg) {
              broadcastToSession(sessionId, terminalMsg);
            }

            // engine_done closes the SDK run, but only an explicit completed
            // outcome closes the durable user turn.
            if (towerMsg.type === 'engine_done') {
              const esid = towerMsg.engineSessionId;
              const recoveryOutcome = towerMsg.outcome ?? (engineName === 'pi' ? 'failed' : 'completed');
              const durableAssistantMessageId = towerMsg.assistantMessageId
                || (counts.assistant > 0 && counts.saved > 0 ? `recovered:${userMessageId || sessionId}` : undefined);
              const terminalDecision = decideTurnTerminal({
                sessionId,
                rootTurnId: userMessageId || `recovery:${sessionId}`,
                engineOutcome: recoveryOutcome,
                assistantMessageId: durableAssistantMessageId,
                error: towerMsg.error,
              });
              broadcastToAll(toTurnTerminalMessage(terminalDecision));
              const completed = terminalDecision.outcome === 'completed';
              if (userMessageId) {
                try {
                  await markAgentTurnCheckpoint(userMessageId, {
                    status: completed ? 'completed' : (recoveryOutcome === 'retryable_failure' ? 'waiting_retry' : 'needs_attention'),
                    sessionId,
                    engine: engineName,
                    model: towerMsg.model || autoResumeModel || null,
                    engineSessionId: esid || engineSessionId || null,
                    error: completed ? null : terminalDecision.error,
                  });
                } catch (err) {
                  console.warn(`[auto-resume] checkpoint terminal update failed for ${sessionId.slice(0, 8)}:`, err);
                }
              }
              if (!completed) {
                console.warn(`[auto-resume] incomplete durable outcome session=${sessionId.slice(0, 8)} outcome=${recoveryOutcome} ${summarizeAutoResumeMessageCounts(counts)}`);
                if (recoveryOutcome === 'retryable_failure' && userMessageId) {
                  durableRetryScheduled = true;
                }
                continue;
              }
              if (esid) {
                try { await claimActiveEngineSessionId(sessionId, engineName, esid); } catch {}
              }
              try {
                await settleRecoveredTaskSession(sessionId, 'done', (type, payload) => broadcastToAll({ type, ...payload }));
              } catch (err) {
                console.warn(`[auto-resume] recovered task settlement failed for ${sessionId.slice(0, 8)}:`, err);
              }
              try {
                const currentSession = await getSession(sessionId);
                if (currentSession) {
                  const newTurnCount = (currentSession.turnCount ?? 0) + 1;
                  const existingFiles: string[] = currentSession.filesEdited || [];
                  const newFiles = towerMsg.editedFiles || [];
                  const mergedFiles = [...new Set([...existingFiles, ...newFiles])];
                  const updates: any = {
                    turnCount: newTurnCount,
                    filesEdited: mergedFiles,
                  };
                  const candidateModel = towerMsg.model || autoResumeModel;
                  if (modelMatchesEngineForAutoResume(candidateModel, engineName)) {
                    updates.modelUsed = engineName === 'pi' ? normalizePiSessionModelId(candidateModel) : candidateModel;
                  } else if (candidateModel) {
                    console.log(`[auto-resume] engine_done: skipping modelUsed update — "${candidateModel}" does not match engine="${engineName}"`);
                  }
                  await updateSession(sessionId, updates);

                  // Session continuity card — background refresh, never blocks resume.
                  try {
                    const { scheduleSessionMemoryCardRefresh } = await import('../services/ai/session-memory-card.js');
                    scheduleSessionMemoryCardRefresh(sessionId);
                  } catch {}

                  // Server-side auto-name (helper — mirrored from handleChat path).
                  // Per workspace/decisions/2026-05-17-auto-name-drift-in-resume-path.md:
                  // first turns interrupted by SIGKILL never got named because this
                  // resume path silently dropped the auto-name call.
                  await tryAutoNameSession(sessionId);
                }
              } catch {}
            }
          }
        } catch (error: any) {
          try {
            await settleRecoveredTaskSession(sessionId, 'failed', (type, payload) => broadcastToAll({ type, ...payload }), error?.message || String(error));
          } catch (settleErr) {
            console.warn(`[auto-resume] recovered task failed-state settlement failed for ${sessionId.slice(0, 8)}:`, settleErr);
          }
          if (userMessageId) {
            try {
              await markAgentTurnCheckpoint(userMessageId, {
                status: 'failed',
                sessionId,
                engine: engineName,
                model: autoResumeModel || null,
                engineSessionId: engineSessionId || null,
                error: error?.message || String(error),
              });
            } catch (checkpointErr) {
              console.warn(`[auto-resume] checkpoint failed-state update failed for ${sessionId.slice(0, 8)}:`, checkpointErr);
            }
          }
          console.error(`[auto-resume] ERROR session=${sessionId.slice(0, 8)} ${summarizeAutoResumeMessageCounts(counts)}:`, error.message || error);
          broadcastToSession(sessionId, {
            type: 'error',
            message: error.message || 'Auto-resume failed',
            sessionId,
          });
        } finally {
          if (hangTimer) clearTimeout(hangTimer);
          activeTurnTimings.delete(sessionId);
          broadcastToAll({
            type: 'session_status',
            sessionId,
            status: 'idle',
            turnTiming: null,
            serverNow: new Date().toISOString(),
          });
          if (started && counts.saved > 0) {
            broadcastToAll({
              type: 'session_refresh_needed',
              sessionId,
              reason: 'auto_resume_completed',
            });
          }
          const noAssistant = counts.assistant === 0 ? ' no_assistant=true' : '';
          console.log(`[auto-resume] END session=${sessionId.slice(0, 8)} started=${started}${noAssistant} ${summarizeAutoResumeMessageCounts(counts)}`);
        }
      } catch (err: any) {
        console.error(`[auto-resume] FATAL session=${sessionId.slice(0, 8)} ${summarizeAutoResumeMessageCounts(counts)}:`, err.message || err);
      } finally {
        autoResumeSessionsInFlight.delete(sessionId);
        if (durableRetryScheduled) {
          // Durable settlement owns the exact `next_attempt_at`. Wake the shared
          // dispatcher after the in-memory fence is released; its due query and
          // the existing owner-token claim decide whether this turn can run.
          wakeAgentTurnDispatcher(21_000);
        }
      }
    })();

    // Stagger resumes by 2s to avoid overwhelming concurrent session limit
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

/** Dispatch due durable retries through the existing fenced recovery executor. */
export async function dispatchDueAgentTurnRetries(candidates: AgentTurnDispatchCandidate[]) {
  await resumeInterruptedDetails(candidates.map((candidate) => ({
    id: candidate.sessionId,
    claudeSessionId: candidate.engineSessionId || undefined,
    userMessageId: candidate.rootTurnId,
    recoverySource: 'durable-dispatcher',
  })));
}

export async function serverSideResumeInterrupted() {
  const rawDetails: InterruptedTurnDetail[] | undefined = (globalThis as any).__interruptedSessionDetails;
  if (!rawDetails || rawDetails.length === 0) return;
  // Startup consumes its handoff once. Later retries use the shared dispatcher.
  delete (globalThis as any).__interruptedSessionDetails;
  await resumeInterruptedDetails(rawDetails);
}

function send(ws: WebSocket, data: any) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
