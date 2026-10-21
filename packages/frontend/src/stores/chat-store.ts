import type { ContextMeasurement } from '../utils/context-measurement';
import type { UploadProgressSnapshot } from '../utils/upload-with-progress';
import { create } from 'zustand';

// --- Message Queue lifecycle ---
// Queued prompts are safe only inside the current page lifetime. Persisting them
// across reload/reconnect made an old prompt look like fresh human input and
// could repeat side effects without user confirmation. Draft text has its own
// persistence; the execution queue deliberately does not.
const LEGACY_QUEUE_STORAGE_KEY = 'tower:messageQueue';

function saveQueueToStorage(_queue: Record<string, string[]>) {
  try {
    // Remove data written by older builds as soon as the queue changes.
    localStorage.removeItem(LEGACY_QUEUE_STORAGE_KEY);
  } catch { /* storage unavailable */ }
}

export function loadQueueFromStorage(): Record<string, string[]> {
  try {
    // Legacy string[] queues have no timestamp, origin turn, or confirmation
    // provenance, so they must never be replayed automatically after reload.
    localStorage.removeItem(LEGACY_QUEUE_STORAGE_KEY);
  } catch { /* storage unavailable */ }
  return {};
}

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, any>;
  result?: string;
}

export interface ThinkingBlock {
  text: string;
  title?: string;
}

export interface AgentRunBlock {
  workerId?: string;
  runId?: string;
  backingSessionId?: string;
  workerName?: string;
  workerRole?: string;
  workerFace?: string;
  workerTagline?: string;
  fromName?: string;
  parentSessionId?: string;
  parentSessionName?: string;
  mode?: string;
  status?: string;
  summary?: string;
  detailArtifacts?: string;
  detailArtifactPaths?: string[];
  detailArtifactSummary?: string;
  readIfNeeded?: string;
  retrievalHint?: string;
  suggestedNext?: string;
  injectedAt?: string;
}

export interface ContentBlock {
  type: 'text' | 'commentary' | 'artifact_markdown' | 'tool_use' | 'tool_result' | 'thinking' | 'agent_run';
  text?: string;
  /** Assistant-authored Markdown saved from the same chat body without duplicate generation. */
  path?: string;
  portablePath?: string;
  title?: string;
  sha256?: string;
  status?: 'saved' | 'pending' | 'skipped' | 'error';
  operation?: 'create' | 'update';
  error?: string;
  /** Provider commentary/preamble channel. `progress` renders as user-visible assistant prose; hidden stays private. */
  phase?: 'commentary';
  visibility?: 'hidden' | 'progress';
  toolUse?: ToolUse;
  thinking?: ThinkingBlock;
  agentRun?: AgentRunBlock;
}

export type PresentFileEvent = { path: string; split: 'right'; sessionId?: string; deliveryId?: string; focus?: boolean; reveal?: boolean; label?: string };

function extractPresentFileEvents(messages: ChatMessage[]): PresentFileEvent[] {
  const events: PresentFileEvent[] = [];
  const toolNamesById = new Map<string, string>();
  for (const msg of messages) {
    for (const block of msg.content || []) {
      const tool = block.toolUse;
      if (!tool) continue;
      if (block.type === 'tool_use' && tool.id && tool.name) toolNamesById.set(tool.id, tool.name);

      const sourceToolName = block.type === 'tool_result' && tool.id ? toolNamesById.get(tool.id) : tool.name;
      const opensViewer = sourceToolName === 'present_file' || sourceToolName === 'personal_note_append' || (['create_markdown_artifact', 'update_markdown_artifact'].includes(sourceToolName || ''));
      if (!opensViewer || !tool.result) continue;

      try {
        const parsed = JSON.parse(tool.result);
        if (['create_markdown_artifact', 'update_markdown_artifact'].includes(sourceToolName || '') && parsed.presentation !== 'viewer') continue;
        const target = typeof parsed.path === 'string' ? parsed.path : typeof parsed.uri === 'string' ? parsed.uri : null;
        if (parsed?.ok && target) events.push({ path: target, split: 'right', deliveryId: tool.id, focus: parsed.focus !== false, ...(parsed.reveal === true ? { reveal: true } : {}), label: parsed.label });
      } catch { /* ignore non-JSON/error result */ }
    }
  }
  return events;
}

function dispatchLatestPresentFileEvent(messages: ChatMessage[]) {
  if (typeof window === 'undefined') return;
  const latest = extractPresentFileEvents(messages).at(-1);
  if (!latest) return;
  window.setTimeout(() => window.dispatchEvent(new CustomEvent('tower-present-file', {
    detail: { ...latest, sessionId: useChatStore.getState().sessionId },
  })), 0);
}

export interface ChatMessage {
  id: string;
  /**
   * URL anchor token (8자 base32) — `/s/<sessionShortCode>#m-<shortId>` 형태로
   * 메시지 직접 링크. (session_id, short_id) composite unique — 세션 안에서만 유효.
   * 마이그레이션 069 이전 메시지는 부팅 시 backfill 후 채워짐. NULL 가능 (전송 직후·backfill 직전).
   * 결정: issue #11 Phase 3 메시지 앵커.
   */
  shortId?: string;
  role: MessageRole;
  content: ContentBlock[];
  timestamp: number;
  /** Last persisted update timestamp from DB, when available. Not used for ordering. */
  updatedAt?: number;
  /** Assistant completion timestamp from DB, when metrics have finalized. */
  completedAt?: number;
  username?: string;
  parentToolUseId?: string | null;
  sendStatus?: 'pending' | 'queued' | 'delivered' | 'failed';
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  /** Model context window captured with this assistant turn, when provider reports it. */
  contextWindowSize?: number;
  /** Post-compaction/live-context estimate. Lower than raw provider input after compact. */
  contextCompacted?: boolean;
  contextEstimatedTokens?: number;
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
  /**
   * Hidden flags / debug markers — see migration 055 + decision
   * 2026-05-10-server-resume-prompt-hidden.md.
   * Known keys:
   *   - hidden: 'server-resume' — message is render-skipped (used to
   *     trigger SDK resume after a server restart without polluting the chat).
   */
  metadata?: { hidden?: string; [key: string]: any } | null;
}

export interface CostInfo {
  contextMeasurement?: ContextMeasurement;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  duration?: number;
  // Cumulative across turns
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  turnCount: number;
  // Context window tracking (from SDK last iteration)
  contextInputTokens: number;   // provider-reported input-side usage for the turn
  contextOutputTokens: number;  // last iteration output
  contextSnapshot?: unknown;
  compactThresholdTokens?: number;
  contextWindowSize: number;    // model's context window (e.g. 200000)
  contextCompacted?: boolean;
  contextEstimatedTokens?: number; // post-compaction/live-context estimate when raw input is stale
}

export interface TurnMetrics {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  durationMs: number;
  /** Frontend-observed completion timestamp; DB reload may replace with persisted completed_at. */
  completedAt?: number;
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
}

export interface RateLimitInfo {
  status: string;
  resetsAt?: number;
  type?: string;
}

export interface SlashCommandInfo {
  name: string;
  description: string;
  source: 'sdk' | 'commands' | 'skills' | 'native' | 'workflow';
  scope?: 'company' | 'project' | 'personal' | 'system';
  kind?: 'native' | 'skill' | 'workflow';
  canonical?: string;
  aliases?: string[];
  displayName?: string;
  summary?: string;
  argumentHint?: string;
  risk?: 'low' | 'medium' | 'high' | 'destructive' | 'external-send' | 'deploy';
}

export interface Attachment {
  id: string;
  type: 'prompt' | 'command' | 'file' | 'upload';
  label: string;
  content: string;
  /** File size in bytes (file attachments only) */
  size?: number;
  /** MIME type (file attachments only) */
  mimeType?: string;
  /** Legacy temp path before project finalization. */
  tempPath?: string;
  /** Owner/session-scoped attachment id. Present when content is a session:// URI. */
  sessionAttachmentId?: string;
  /** Temporary attachments expire unless explicitly promoted. */
  expiresAt?: string;
}

export interface PendingQuestion {
  questionId: string;
  sessionId: string;
  submissionStatus?: 'pending' | 'submitting' | 'send_failed';
  submissionError?: string;
  questions: Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
}

export type TurnPhase =
  | 'idle'
  | 'queued'
  | 'preparing'
  | 'streaming'
  | 'tool_running'
  | 'stalled'
  | 'closing'
  | 'awaiting_user'
  | 'compacting'
  | 'done'
  | 'stopped'
  | 'error';

export interface SessionTurnState {
  phase: TurnPhase;
  startedAt: number | null;
  lastActivityAt: number | null;
  pendingMessageCount: number;
  activeToolUseId?: string;
  activeToolId?: string;
  activeToolName?: string;
  activeToolSummary?: string;
  /** Assistant message id for the currently streaming turn, once the first assistant frame arrives. */
  activeAssistantMessageId?: string;
  pendingQuestionId?: string | null;
  errorMessage?: string;
  /** Safe-stop request accepted; active foreground work may still be finishing. */
  stopRequested?: boolean;
  /** What the safe stop is waiting for, when known from the server. */
  stopWaitingFor?: 'active_tool' | 'engine_boundary';
  /** True when the user has viewed this session after the turn ended (done/stopped/error).
   *  Badge hides once read. Resets when a new turn starts (preparing). */
  read?: boolean;
}

interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  sessionId: string | null;
  engineSessionId: string | null;
  slashCommands: SlashCommandInfo[];
  tools: string[];
  model: string | null;
  cost: CostInfo;
  rateLimit: RateLimitInfo | null;
  attachments: Attachment[];
  attachmentDrafts: Record<string, Attachment[]>;
  attachmentUploadProgress: Record<string, UploadProgressSnapshot | null>;
  setAttachmentUploadProgress: (sessionId: string, progress: UploadProgressSnapshot | null) => void;
  pendingQuestion: PendingQuestion | null;
  compactingSessionId: string | null;
  sessionStartTime: number | null;
  turnStartTime: number | null;
  lastTurnMetrics: TurnMetrics | null;
  /** Per-session message queue: sessionId → messages[] */
  messageQueue: Record<string, string[]>;
  /**
   * Per-session mid-turn injections awaiting agent pickup: sessionId → items.
   * These are NOT in `messages` yet — they render as "전달 대기 중" chips above
   * the input and get spliced into the transcript at their injection point when
   * the engine confirms consumption (steer_delivered). See GitHub issue #17.
   */
  pendingInjections: Record<string, Array<{ id: string; text: string; order?: number }>>;
  /** Runtime turn state per session */
  turnStateBySession: Record<string, SessionTurnState>;
  /** Pagination state for windowed message loading */
  hasMoreMessages: boolean;
  loadingMoreMessages: boolean;
  oldestMessageId: string | null;
  /** Incremented when background refresh replaces messages — signals ChatPanel to scroll to bottom */
  scrollGeneration: number;
  /** True while switching to a session and loading its messages from server */
  sessionLoading: boolean;

  addMessage: (msg: ChatMessage) => void;
  updateAssistantById: (id: string, content: ContentBlock[], timestamp?: number) => void;
  /**
   * Force-apply any pending RAF-batched assistant updates immediately. Call
   * this at turn boundaries (turn_done / engine_done) so the last cumulative
   * content lands in the messages array even if the browser's RAF callback
   * has been delayed or skipped (background tab, CPU pressure, virtualization).
   * Without this, PI multi-iteration turns can leave only the first chunk
   * visible until the user refreshes (issue #46).
   */
  flushAssistantUpdates: () => void;
  appendToLastAssistant: (block: ContentBlock) => void;
  attachToolResult: (toolUseId: string, result: string) => void;
  markLatestUserQueued: (text: string) => void;
  promoteLatestQueuedUser: (text: string) => void;
  clearQueuedUsersForSession: (sessionId: string) => void;
  cancelQueuedMessage: (messageId: string) => string | null;
  cancelQueuedMessageAtIndex: (sessionId: string, index: number) => string | null;
  setStreaming: (v: boolean) => void;
  setSessionId: (id: string | null) => void;
  setEngineSessionId: (id: string | null) => void;
  setSystemInfo: (info: { slashCommands?: string[] | SlashCommandInfo[]; tools?: string[]; model?: string }) => void;
  setCost: (cost: Partial<CostInfo>) => void;
  setRateLimit: (info: RateLimitInfo | null) => void;
  setCompacting: (sessionId: string | null) => void;
  setMessages: (msgs: ChatMessage[], options?: { replayPresentFile?: boolean }) => void;
  /**
   * 한 세션 안 메시지 여러 건의 shortId 를 한 번에 patch (issue #11 메시지 앵커).
   * lazy fetch 패턴 — AnchorLinkButton 이 shortId 없는 메시지에서 클릭됐을 때
   * 백엔드 응답으로 받은 short_id 들을 store 에 박는다. 이미 있는 shortId 는 덮어쓰지 않음.
   */
  patchMessageShortIds: (updates: Array<{ id: string; shortId: string }>) => void;
  clearMessages: () => void;
  setSessionStartTime: (time: number | null) => void;
  setTurnStartTime: (time: number | null) => void;
  markPendingDelivered: () => void;
  markPendingFailed: () => void;
  /** Add a mid-turn injection to the per-session pending list (chips). */
  addPendingInjection: (sessionId: string, id: string, text: string) => void;
  /** Remove one pending injection (e.g. after it's delivered or cancelled). */
  removePendingInjection: (sessionId: string, id: string) => void;
  /** Drain all pending injections for a session (returns them for flushing). */
  drainPendingInjections: (sessionId: string) => Array<{ id: string; text: string; order?: number }>;
  retryMessage: (id: string) => string | null;
  setLastTurnMetrics: (m: TurnMetrics | null) => void;
  addAttachment: (att: Attachment, sessionId?: string) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  setPendingQuestion: (pq: PendingQuestion | null) => void;
  updateMessageMetrics: (id: string, metrics: { durationMs?: number; completedAt?: number; inputTokens?: number; outputTokens?: number; reasoningTokens?: number; contextEstimatedTokens?: number; stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' }) => void;
  enqueueMessage: (sessionId: string, message: string) => void;
  dequeueMessage: (sessionId: string) => string | null;
  removeQueuedMessage: (sessionId: string, index: number) => void;
  clearSessionQueue: (sessionId: string) => void;
  setTurnPhase: (sessionId: string, phase: TurnPhase, meta?: Partial<Omit<SessionTurnState, 'phase'>>) => void;
  /** Mark the turn badge as read (user viewed the session). Badge hides for done/stopped/error. */
  markTurnRead: (sessionId: string) => void;
  clearTurnState: (sessionId: string) => void;
  setHasMoreMessages: (v: boolean) => void;
  setLoadingMoreMessages: (v: boolean) => void;
  setOldestMessageId: (id: string | null) => void;
  prependMessages: (msgs: ChatMessage[]) => void;
  bumpScrollGeneration: () => void;
  setSessionLoading: (v: boolean) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isStreaming: false,
  sessionId: null,
  engineSessionId: null,
  slashCommands: [],
  tools: [],
  model: null,
  cost: { totalCost: 0, inputTokens: 0, outputTokens: 0, cumulativeInputTokens: 0, cumulativeOutputTokens: 0, turnCount: 0, contextInputTokens: 0, contextOutputTokens: 0, contextWindowSize: 0, contextEstimatedTokens: 0 },
  rateLimit: null,
  attachments: [],
  attachmentDrafts: {},
  attachmentUploadProgress: {},
  setAttachmentUploadProgress: (sessionId, progress) => set((state) => ({
    attachmentUploadProgress: { ...state.attachmentUploadProgress, [sessionId]: progress },
  })),
  pendingQuestion: null,
  compactingSessionId: null,
  sessionStartTime: null,
  turnStartTime: null,
  lastTurnMetrics: null,
  messageQueue: loadQueueFromStorage(),
  pendingInjections: {},
  turnStateBySession: {},
  hasMoreMessages: false,
  loadingMoreMessages: false,
  oldestMessageId: null,
  scrollGeneration: 0,
  sessionLoading: false,

  addMessage: (msg) => set((s) => {
    if (s.messages.some((m) => m.id === msg.id)) {
      console.warn('[chat-store] duplicate message dropped:', msg.id, msg.role);
      return s;
    }
    return { messages: [...s.messages, msg] };
  }),

  // RAF-throttled: during fast streaming, multiple updateAssistantById calls
  // within one animation frame are batched into a single Zustand state update.
  // This prevents React from re-rendering 60+ times/sec when tokens arrive rapidly.
  //
  // 2026-05-27 — issue #46 mitigation:
  // RAF callbacks can be silently delayed (background tab, CPU pressure,
  // Virtuoso virtualization off-screen), which caused PI multi-iteration
  // turns to surface only the first chunk until the user refreshed. We now
  // (a) keep a setTimeout(60ms) fallback that flushes if RAF hasn't fired,
  // (b) expose flushAssistantUpdates() so turn_done can force-apply pending
  // before clearing the streaming flag, and (c) when applying, fall back to
  // adding a missing message instead of dropping the update on idx === -1.
  ...(() => {
    let pending: Map<string, { content: ContentBlock[]; timestamp?: number }> | null = null;
    let rafId: number | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const apply = () => {
      const batchMap = pending;
      pending = null;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (!batchMap || batchMap.size === 0) return;

      set((s) => {
        let changed = false;
        const msgs = [...s.messages];
        for (const [batchId, entry] of batchMap) {
          const idx = msgs.findIndex((m) => m.id === batchId);
          if (idx === -1) {
            // Race fallback: addMessage hasn't been observed in this snapshot,
            // but a content update is already pending for that id. Insert a
            // minimal assistant message so the streamed text isn't lost.
            // Without this, RAF-batched updates that arrived before the
            // creating addMessage applied would be silently dropped.
            msgs.push({
              id: batchId,
              role: 'assistant',
              content: entry.content,
              timestamp: entry.timestamp || Date.now(),
            } as ChatMessage);
            changed = true;
            continue;
          }
          // Assistant bubbles are created when the first token arrives, but
          // users read the timestamp as "when the answer landed". Prefer the
          // server emission time so reconnects/restarts do not freeze the UI
          // at the first-token timestamp; fall back to browser time for older
          // engine events that do not carry timestamp yet.
          msgs[idx] = { ...msgs[idx], content: entry.content, timestamp: entry.timestamp || Date.now() };
          changed = true;
        }
        return changed ? { messages: msgs } : s;
      });
    };

    return {
      updateAssistantById: (id: string, content: ContentBlock[], timestamp?: number) => {
        if (!pending) pending = new Map();
        pending.set(id, { content, timestamp });
        if (rafId === null) {
          rafId = requestAnimationFrame(() => {
            rafId = null;
            apply();
          });
        }
        if (timeoutId === null) {
          // 60ms ≈ 4 frames at 60Hz. If the browser throttles RAF below that
          // (background tab, dev tools open, weak device), the timeout flushes
          // so streaming text never gets stuck at the first chunk.
          timeoutId = setTimeout(() => {
            timeoutId = null;
            apply();
          }, 60);
        }
      },
      flushAssistantUpdates: () => apply(),
    };
  })(),

  appendToLastAssistant: (block) =>
    set((s) => {
      const msgs = [...s.messages];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') {
          msgs[i] = { ...msgs[i], content: [...msgs[i].content, block] };
          break;
        }
      }
      return { messages: msgs };
    }),

  attachToolResult: (toolUseId, result) =>
    set((s) => {
      let presentFileEvent: PresentFileEvent | null = null;
      const msgs = s.messages.map((msg) => {
        if (msg.role !== 'assistant') return msg;
        const updated = msg.content.map((block) => {
          if (block.type === 'tool_use' && block.toolUse?.id === toolUseId) {
            // present_file live delivery uses a user-scoped backend intent so it
            // also reaches browsers viewing another session. Replaying stored
            // messages still restores it via dispatchLatestPresentFileEvent.
            if (block.toolUse.name === 'personal_note_append') {
              try {
                const parsed = JSON.parse(result);
                const target = typeof parsed.path === 'string' ? parsed.path : typeof parsed.uri === 'string' ? parsed.uri : null;
                if (parsed?.ok && parsed.focus !== false && target) presentFileEvent = { path: target, split: 'right' };
              } catch { /* non-JSON/error result: do not dispatch */ }
            }
            return { ...block, toolUse: { ...block.toolUse, result } };
          }
          return block;
        });
        return { ...msg, content: updated };
      });
      if (presentFileEvent && typeof window !== 'undefined') {
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('tower-open-path', { detail: presentFileEvent })), 0);
      }
      return { messages: msgs };
    }),

  markLatestUserQueued: (text) =>
    set((s) => {
      const normalized = text.trim();
      if (!normalized) return s;
      for (let i = s.messages.length - 1; i >= 0; i--) {
        const msg = s.messages[i];
        if (msg.role !== 'user' || msg.sendStatus !== 'pending') continue;
        const body = msg.content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n').trim();
        if (body === normalized) {
          const next = [...s.messages];
          next[i] = { ...msg, sendStatus: 'queued' };
          return { messages: next };
        }
      }
      return s;
    }),

  promoteLatestQueuedUser: (text) =>
    set((s) => {
      const normalized = text.trim();
      if (!normalized) return s;
      for (let i = s.messages.length - 1; i >= 0; i--) {
        const msg = s.messages[i];
        if (msg.role !== 'user' || msg.sendStatus !== 'queued') continue;
        const body = msg.content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n').trim();
        if (body === normalized) {
          const next = [...s.messages];
          next[i] = { ...msg, sendStatus: 'pending' };
          return { messages: next };
        }
      }
      return s;
    }),

  clearQueuedUsersForSession: (sessionId) =>
    set((s) => {
      if (s.sessionId !== sessionId) return s;
      return {
        messages: s.messages.map((msg) =>
          msg.role === 'user' && msg.sendStatus === 'queued'
            ? { ...msg, sendStatus: 'failed' as const }
            : msg
        ),
      };
    }),

  cancelQueuedMessage: (messageId) => {
    const state = get();
    const idx = state.messages.findIndex((m) => m.id === messageId && m.role === 'user' && m.sendStatus === 'queued');
    if (idx === -1) return null;
    const msg = state.messages[idx];
    const text = msg.content.find((b) => b.type === 'text')?.text?.trim() || null;
    if (!text) return null;

    const sid = state.sessionId;
    if (!sid) return null;
    const queue = state.messageQueue[sid] || [];
    const removeIndex = queue.findIndex((q) => q.trim() === text);
    const nextQueue = removeIndex >= 0 ? queue.filter((_, i) => i !== removeIndex) : queue;
    const updatedQueue = { ...state.messageQueue, [sid]: nextQueue };
    saveQueueToStorage(updatedQueue);

    set((s) => {
      const nextMessages = s.messages.filter((m) => m.id !== messageId);
      const prev = s.turnStateBySession[sid];
      return {
        messages: nextMessages,
        messageQueue: updatedQueue,
        turnStateBySession: {
          ...s.turnStateBySession,
          [sid]: {
            phase: nextQueue.length > 0 ? 'queued' : (prev?.phase === 'queued' ? 'idle' : (prev?.phase || 'idle')),
            startedAt: prev?.startedAt ?? null,
            lastActivityAt: Date.now(),
            pendingMessageCount: nextQueue.length,
            activeToolName: prev?.activeToolName,
            activeToolSummary: prev?.activeToolSummary,
            pendingQuestionId: prev?.pendingQuestionId,
            errorMessage: prev?.errorMessage,
          },
        },
      };
    });

    return text;
  },

  cancelQueuedMessageAtIndex: (sessionId, index) => {
    const state = get();
    const queue = state.messageQueue[sessionId] || [];
    if (index < 0 || index >= queue.length) return null;
    const text = queue[index];
    const nextQueue = queue.filter((_, i) => i !== index);
    const updatedQueue = { ...state.messageQueue, [sessionId]: nextQueue };
    saveQueueToStorage(updatedQueue);

    set((s) => {
      // Remove the matching queued user bubble (first match with same text).
      // Only touch the messages list if the chat is on this session; otherwise
      // the bubble belongs to another session's cached messages and isn't in view.
      let nextMessages = s.messages;
      if (s.sessionId === sessionId) {
        const normalized = text.trim();
        const removeAt = s.messages.findIndex(
          (m) =>
            m.role === 'user' &&
            m.sendStatus === 'queued' &&
            m.content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n').trim() === normalized,
        );
        if (removeAt >= 0) {
          nextMessages = [...s.messages.slice(0, removeAt), ...s.messages.slice(removeAt + 1)];
        }
      }
      const prev = s.turnStateBySession[sessionId];
      return {
        messages: nextMessages,
        messageQueue: updatedQueue,
        turnStateBySession: {
          ...s.turnStateBySession,
          [sessionId]: {
            phase: nextQueue.length > 0 ? 'queued' : (prev?.phase === 'queued' ? 'idle' : (prev?.phase || 'idle')),
            startedAt: prev?.startedAt ?? null,
            lastActivityAt: Date.now(),
            pendingMessageCount: nextQueue.length,
            activeToolUseId: prev?.activeToolUseId,
            activeToolId: prev?.activeToolId,
            activeToolName: prev?.activeToolName,
            activeToolSummary: prev?.activeToolSummary,
            pendingQuestionId: prev?.pendingQuestionId,
            errorMessage: prev?.errorMessage,
          },
        },
      };
    });

    return text;
  },

  setStreaming: (v) => set({ isStreaming: v }),
  setCompacting: (sessionId) => set({ compactingSessionId: sessionId }),
  setSessionId: (id) => set((state) => {
    if (id === state.sessionId) return {};
    const attachmentDrafts = { ...state.attachmentDrafts };
    if (state.sessionId) attachmentDrafts[state.sessionId] = state.attachments;
    return { sessionId: id, attachmentDrafts, attachments: id ? attachmentDrafts[id] || [] : [] };
  }),
  setEngineSessionId: (id) => set({ engineSessionId: id }),
  setSystemInfo: (info) =>
    set((s) => {
      let commands = s.slashCommands;
      if (info.slashCommands) {
        // Normalize: SDK sends string[], convert to SlashCommandInfo[]
        commands = info.slashCommands.map((cmd) =>
          typeof cmd === 'string'
            ? { name: cmd, description: '', source: 'sdk' as const }
            : cmd
        );
      }
      return {
        slashCommands: commands,
        tools: info.tools ?? s.tools,
        model: info.model ?? s.model,
      };
    }),
  setCost: (cost) => set((s) => {
    const newInput = cost.inputTokens ?? 0;
    const newOutput = cost.outputTokens ?? 0;
    const hasExplicitCumulativeInput = cost.cumulativeInputTokens !== undefined;
    const hasExplicitCumulativeOutput = cost.cumulativeOutputTokens !== undefined;
    const hasExplicitTurnCount = cost.turnCount !== undefined;
    const merged = {
      ...s.cost,
      ...cost,
      // Reset/session-switch callers pass explicit cumulative/turnCount=0.
      // Live turn metric callers omit them, so we increment from this turn's usage.
      cumulativeInputTokens: hasExplicitCumulativeInput
        ? cost.cumulativeInputTokens!
        : s.cost.cumulativeInputTokens + newInput,
      cumulativeOutputTokens: hasExplicitCumulativeOutput
        ? cost.cumulativeOutputTokens!
        : s.cost.cumulativeOutputTokens + newOutput,
      turnCount: hasExplicitTurnCount
        ? cost.turnCount!
        : s.cost.turnCount + (newInput > 0 || newOutput > 0 ? 1 : 0),
    };
    return { cost: merged };
  }),
  setRateLimit: (info) => set({ rateLimit: info }),
  setMessages: (msgs, options) => {
    if (options?.replayPresentFile) dispatchLatestPresentFileEvent(msgs);
    set({ messages: msgs });
  },
  patchMessageShortIds: (updates) => set((s) => {
    if (updates.length === 0) return s;
    const map = new Map(updates.map((u) => [u.id, u.shortId]));
    let changed = false;
    const msgs = s.messages.map((m) => {
      if (m.shortId) return m; // 이미 있으면 그대로
      const sid = map.get(m.id);
      if (!sid) return m;
      changed = true;
      return { ...m, shortId: sid };
    });
    return changed ? { messages: msgs } : s;
  }),
  clearMessages: () => set({ messages: [], cost: { totalCost: 0, inputTokens: 0, outputTokens: 0, cumulativeInputTokens: 0, cumulativeOutputTokens: 0, turnCount: 0, contextInputTokens: 0, contextOutputTokens: 0, contextWindowSize: 0, contextEstimatedTokens: 0 }, rateLimit: null, pendingQuestion: null, lastTurnMetrics: null, hasMoreMessages: false, loadingMoreMessages: false, oldestMessageId: null, compactingSessionId: null, engineSessionId: null }),
  setSessionStartTime: (time) => set({ sessionStartTime: time }),
  setTurnStartTime: (time) => set({ turnStartTime: time }),
  markPendingDelivered: () =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.sendStatus === 'pending' ? { ...m, sendStatus: 'delivered' as const } : m
      ),
    })),
  markPendingFailed: () =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.sendStatus === 'pending' ? { ...m, sendStatus: 'failed' as const } : m
      ),
    })),
  addPendingInjection: (sessionId, id, text) =>
    set((s) => {
      const list = s.pendingInjections[sessionId] || [];
      if (list.some((it) => it.id === id)) return {}; // dedupe
      const maxOrder = list.reduce((max, it, idx) => Math.max(max, typeof it.order === 'number' ? it.order : idx), -1);
      return {
        pendingInjections: { ...s.pendingInjections, [sessionId]: [...list, { id, text, order: maxOrder + 1 }] },
      };
    }),
  removePendingInjection: (sessionId, id) =>
    set((s) => {
      const list = s.pendingInjections[sessionId];
      if (!list) return {};
      const next = list.filter((it) => it.id !== id);
      if (next.length === list.length) return {};
      const updated = { ...s.pendingInjections };
      if (next.length === 0) delete updated[sessionId];
      else updated[sessionId] = next;
      return { pendingInjections: updated };
    }),
  drainPendingInjections: (sessionId) => {
    const list = get().pendingInjections[sessionId] || [];
    if (list.length === 0) return [];
    set((s) => {
      const updated = { ...s.pendingInjections };
      delete updated[sessionId];
      return { pendingInjections: updated };
    });
    return list;
  },
  retryMessage: (id) => {
    const state = get();
    const msg = state.messages.find((m) => m.id === id);
    if (!msg || msg.role !== 'user') return null;
    const text = msg.content.find((b) => b.type === 'text')?.text;
    if (!text) return null;
    // Remove the failed message
    set((s) => ({ messages: s.messages.filter((m) => m.id !== id) }));
    return text;
  },
  setLastTurnMetrics: (m) => set({ lastTurnMetrics: m }),
  addAttachment: (att, sessionId) => set((state) => {
    const owner = sessionId ?? state.sessionId;
    if (!owner || owner === state.sessionId) return state.attachments.some((a) => a.id === att.id) ? {} : { attachments: [...state.attachments, att] };
    return { attachmentDrafts: {
      ...state.attachmentDrafts,
      [owner]: (state.attachmentDrafts[owner] || []).some((a) => a.id === att.id)
        ? state.attachmentDrafts[owner] : [...(state.attachmentDrafts[owner] || []), att],
    } };
  }),
  removeAttachment: (id) => set((state) => ({ attachments: state.attachments.filter((a) => a.id !== id) })),
  clearAttachments: () => set((state) => ({ attachments: [], attachmentDrafts: state.sessionId
    ? { ...state.attachmentDrafts, [state.sessionId]: [] } : state.attachmentDrafts })),
  setPendingQuestion: (pq) => set({ pendingQuestion: pq }),

  updateMessageMetrics: (id, metrics) =>
    set((s) => {
      const idx = s.messages.findIndex((m) => m.id === id);
      if (idx === -1) return s;
      const msgs = [...s.messages];
      msgs[idx] = { ...msgs[idx], ...metrics };
      return { messages: msgs };
    }),

  enqueueMessage: (sessionId, message) => set((s) => {
    const updated = {
      ...s.messageQueue,
      [sessionId]: [...(s.messageQueue[sessionId] || []), message],
    };
    saveQueueToStorage(updated);
    const prev = s.turnStateBySession[sessionId];
    return {
      messageQueue: updated,
      turnStateBySession: {
        ...s.turnStateBySession,
        [sessionId]: {
          phase: 'queued',
          startedAt: prev?.startedAt ?? Date.now(),
          lastActivityAt: Date.now(),
          pendingMessageCount: updated[sessionId]?.length || 0,
          activeToolUseId: prev?.activeToolUseId,
          activeToolId: prev?.activeToolId,
          activeToolName: prev?.activeToolName,
          activeToolSummary: prev?.activeToolSummary,
          pendingQuestionId: prev?.pendingQuestionId,
          errorMessage: prev?.errorMessage,
        },
      },
    };
  }),

  dequeueMessage: (sessionId) => {
    const state = get();
    const queue = state.messageQueue[sessionId];
    if (!queue || queue.length === 0) return null;
    const [first, ...rest] = queue;
    const updated = { ...state.messageQueue, [sessionId]: rest };
    saveQueueToStorage(updated);
    set((s) => {
      const prev = s.turnStateBySession[sessionId];
      return {
        messageQueue: updated,
        turnStateBySession: {
          ...s.turnStateBySession,
          [sessionId]: {
            phase: rest.length > 0 ? 'queued' : (prev?.phase === 'queued' ? 'idle' : (prev?.phase || 'idle')),
            startedAt: prev?.startedAt ?? null,
            lastActivityAt: Date.now(),
            pendingMessageCount: rest.length,
            activeToolUseId: prev?.activeToolUseId,
            activeToolId: prev?.activeToolId,
            activeToolName: prev?.activeToolName,
            activeToolSummary: prev?.activeToolSummary,
            pendingQuestionId: prev?.pendingQuestionId,
            errorMessage: prev?.errorMessage,
          },
        },
      };
    });
    return first;
  },

  removeQueuedMessage: (sessionId, index) => set((s) => {
    const queue = s.messageQueue[sessionId] || [];
    const nextQueue = queue.filter((_, i) => i !== index);
    const updated = {
      ...s.messageQueue,
      [sessionId]: nextQueue,
    };
    saveQueueToStorage(updated);
    const prev = s.turnStateBySession[sessionId];
    return {
      messageQueue: updated,
      turnStateBySession: {
        ...s.turnStateBySession,
        [sessionId]: {
          phase: nextQueue.length > 0 ? 'queued' : (prev?.phase === 'queued' ? 'idle' : (prev?.phase || 'idle')),
          startedAt: prev?.startedAt ?? null,
          lastActivityAt: Date.now(),
          pendingMessageCount: nextQueue.length,
          activeToolUseId: prev?.activeToolUseId,
          activeToolId: prev?.activeToolId,
          activeToolName: prev?.activeToolName,
          activeToolSummary: prev?.activeToolSummary,
          pendingQuestionId: prev?.pendingQuestionId,
          errorMessage: prev?.errorMessage,
        },
      },
    };
  }),

  clearSessionQueue: (sessionId) => set((s) => {
    const { [sessionId]: _, ...rest } = s.messageQueue;
    saveQueueToStorage(rest);
    const prev = s.turnStateBySession[sessionId];
    return {
      messageQueue: rest,
      turnStateBySession: {
        ...s.turnStateBySession,
        [sessionId]: {
          phase: prev?.phase === 'queued' ? 'idle' : (prev?.phase || 'idle'),
          startedAt: prev?.startedAt ?? null,
          lastActivityAt: Date.now(),
          pendingMessageCount: 0,
          activeToolUseId: prev?.activeToolUseId,
          activeToolId: prev?.activeToolId,
          activeToolName: prev?.activeToolName,
          activeToolSummary: prev?.activeToolSummary,
          pendingQuestionId: prev?.pendingQuestionId,
          errorMessage: prev?.errorMessage,
        },
      },
    };
  }),

  setTurnPhase: (sessionId, phase, meta = {}) => set((s) => {
    const prev = s.turnStateBySession[sessionId];
    // Generic active-status heartbeats often move tool_running/streaming back to
    // preparing. They belong to the same root turn and must not reset its clock.
    // Only a transition from an actually terminal/idle state opens a new clock.
    const startsNewTurn = phase === 'preparing'
      && (!prev || prev.phase === 'idle' || prev.phase === 'queued' || prev.phase === 'done' || prev.phase === 'stopped' || prev.phase === 'error');
    // Reset read flag when a new turn begins (preparing) so the badge shows again
    const read = phase === 'preparing' ? false : (meta.read ?? prev?.read ?? false);
    return {
      turnStateBySession: {
        ...s.turnStateBySession,
        [sessionId]: {
          phase: prev?.pendingQuestionId && meta.pendingQuestionId === undefined && phase !== 'stopped' && phase !== 'error' ? 'awaiting_user' : phase,
          startedAt: meta.startedAt ?? (startsNewTurn ? Date.now() : (prev?.startedAt ?? (phase === 'preparing' ? Date.now() : null))),
          lastActivityAt: meta.lastActivityAt ?? Date.now(),
          pendingMessageCount: meta.pendingMessageCount ?? s.messageQueue[sessionId]?.length ?? prev?.pendingMessageCount ?? 0,
          activeToolUseId: meta.activeToolUseId ?? prev?.activeToolUseId,
          activeToolId: meta.activeToolId ?? prev?.activeToolId,
          activeToolName: meta.activeToolName ?? prev?.activeToolName,
          activeToolSummary: meta.activeToolSummary ?? prev?.activeToolSummary,
          activeAssistantMessageId: phase === 'preparing' || phase === 'idle' || phase === 'done' || phase === 'stopped' || phase === 'error'
            ? meta.activeAssistantMessageId
            : (meta.activeAssistantMessageId ?? prev?.activeAssistantMessageId),
          pendingQuestionId: meta.pendingQuestionId !== undefined ? meta.pendingQuestionId : (phase === 'stopped' || phase === 'error' ? null : prev?.pendingQuestionId),
          errorMessage: meta.errorMessage ?? (phase === 'error' ? prev?.errorMessage : undefined),
          read,
        },
      },
    };
  }),

  markTurnRead: (sessionId) => set((s) => {
    const prev = s.turnStateBySession[sessionId];
    if (!prev || prev.read) return s; // no-op if already read or no state
    return {
      turnStateBySession: {
        ...s.turnStateBySession,
        [sessionId]: { ...prev, read: true },
      },
    };
  }),

  clearTurnState: (sessionId) => set((s) => {
    const { [sessionId]: _, ...rest } = s.turnStateBySession;
    return { turnStateBySession: rest };
  }),

  // Pagination actions
  setHasMoreMessages: (v) => set({ hasMoreMessages: v }),
  setLoadingMoreMessages: (v) => set({ loadingMoreMessages: v }),
  setOldestMessageId: (id) => set({ oldestMessageId: id }),
  prependMessages: (msgs) => set((s) => ({ messages: [...msgs, ...s.messages] })),
  bumpScrollGeneration: () => set((s) => ({ scrollGeneration: s.scrollGeneration + 1 })),
  setSessionLoading: (v) => set({ sessionLoading: v }),
}));
