import { useCallback, useEffect, useRef } from 'react';
import { useWebSocket } from './useWebSocket';
import { useChatStore, type ChatMessage, type SlashCommandInfo, type TurnMetrics } from '../stores/chat-store';
import { useFileStore } from '../stores/file-store';
import { useSessionStore } from '../stores/session-store';
import { useModelStore, getModelIdForBackend, resolveEffectiveModel, reconcileSelectedModel } from '../stores/model-store';

/**
 * Effective model for a chat send:
 * - prefer the session's stored modelUsed
 * - fall back to the global selectedModel
 * Returned value is already backend-formatted (no `pi:` prefix).
 */
function effectiveModelForSend(sessionId: string | null | undefined): string {
  const session = sessionId
    ? useSessionStore.getState().sessions.find((s) => s.id === sessionId)
    : null;
  const global = useModelStore.getState().selectedModel;
  const frontendId = resolveEffectiveModel(session, global);
  return getModelIdForBackend(frontendId);
}

function isPiSessionForSend(sessionId: string, backendModel: string): boolean {
  const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
  return session?.engine === 'pi' || !!session?.modelUsed?.includes('/') || backendModel.includes('/');
}
import { useGitStore } from '../stores/git-store';
import { useSettingsStore } from '../stores/settings-store';
import { reloadOnce } from '../utils/app-version';
import { parseSDKMessage, normalizeContentBlocks, getToolSummary } from '../utils/message-parser';
import { shouldDropSessionMessage, shouldResetAssistantRef, resolveAutoNameTarget, resolveSendSessionId, isServerRestarted } from '../utils/session-filters';
import { normalizePendingQuestion } from '../utils/pending-question';
import { buildAskUserQuestionDisplayResult } from '../utils/ask-user-question-result';
import { generateUUID } from '../utils/uuid';
import { toastSuccess, toastError, toastWarning, toastInfo } from '../utils/toast';
import { notifyTaskComplete, requestNotificationPermission } from '../utils/notify';
import { filterPendingSteerMessages } from '../utils/pending-steer-filter';
import { useKanbanStore } from '../stores/kanban-store';
import { useRoomStore } from '../stores/room-store';
import { useAiPanelStore } from '../stores/ai-panel-store';
import { useProjectStore } from '../stores/project-store';
import { useAgentDraftStore, type AgentDraftArtifact } from '../stores/agent-draft-store';
import { getCurrentUsername } from '../utils/auth';
import { markSessionRunActive, markSessionRunAwaitingUser, markSessionRunFinished, markSessionRunIdle, markSessionRunQueued, markSessionRunWaitingRetry } from '../features/session-run-state/session-run-actions';
import { syncServerClock } from '../utils/server-clock';
import { presentChatRuntimeError } from '../utils/chat-runtime-error';

/** Debounce timers for auto-reload of externally changed files, keyed by path. */
const fileChangeDebounces = new Map<string, ReturnType<typeof setTimeout>>();

// Best-effort live-view tombstone for Pi steer cancellation races. A cancelled
// steer can still produce a delayed steer_delivered event if the backend had
// already queued it before processing cancel_steer. Keep a small session-local
// guard so the cancelled user bubble does not reappear in the transcript.
const cancelledSteerMessageIds = new Set<string>();

// Inbox preview is useful for background sessions, but writing it to the global
// session store on every assistant snapshot still wakes every subscriber of
// lastTurnTextBySession. Coalesce it separately from the active chat stream so
// App Shell / Inbox metadata remains a low-frequency plane.
// Decision: workspace/decisions/2026-05-31-realtime-performance-architecture.md
const LAST_TURN_TEXT_FLUSH_MS = Math.max(
  100,
  Number((typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_LAST_TURN_TEXT_FLUSH_MS) || '') || 500,
);

type PendingLastTurnText = {
  text: string;
  finalized: boolean;
  msgId?: string;
};

const pendingLastTurnTextBySession = new Map<string, PendingLastTurnText>();
let lastTurnTextFlushTimer: ReturnType<typeof setTimeout> | null = null;

function flushPendingLastTurnText(sessionId?: string) {
  const store = useSessionStore.getState();
  if (sessionId) {
    const pending = pendingLastTurnTextBySession.get(sessionId);
    if (!pending) return;
    pendingLastTurnTextBySession.delete(sessionId);
    store.setLastTurnText(sessionId, pending.text, pending.finalized, pending.msgId);
    return;
  }

  if (lastTurnTextFlushTimer) {
    clearTimeout(lastTurnTextFlushTimer);
    lastTurnTextFlushTimer = null;
  }
  for (const [sid, pending] of pendingLastTurnTextBySession.entries()) {
    store.setLastTurnText(sid, pending.text, pending.finalized, pending.msgId);
  }
  pendingLastTurnTextBySession.clear();
}

function queueLastTurnText(sessionId: string, text: string, finalized = false, msgId?: string, immediate = false) {
  if (immediate) {
    flushPendingLastTurnText(sessionId);
    useSessionStore.getState().setLastTurnText(sessionId, text, finalized, msgId);
    return;
  }

  const prev = pendingLastTurnTextBySession.get(sessionId);
  // Preserve multi-message tool cycles: if a second assistant msgId arrives
  // before the debounce fires, flush the first one now so session-store can
  // accumulate both msgIds instead of the Map replacing one with the other.
  if (prev && prev.msgId && msgId && prev.msgId !== msgId) {
    flushPendingLastTurnText(sessionId);
  }

  pendingLastTurnTextBySession.set(sessionId, { text, finalized, msgId });
  if (!lastTurnTextFlushTimer) {
    lastTurnTextFlushTimer = setTimeout(() => {
      lastTurnTextFlushTimer = null;
      flushPendingLastTurnText();
    }, LAST_TURN_TEXT_FLUSH_MS);
  }
}

/**
 * Normalize assistant prose for Inbox previews.
 *
 * Why this exists:
 * - Assistant content is block-based (text / tool_use / thinking / visuals).
 * - Joining text blocks with '' makes paragraph boundaries disappear,
 *   which feels like the front/back of the answer got cut off.
 * - Inbox should show prose only, but preserve readable separation.
 */
function joinAssistantPreviewText(parts: string[]): string {
  return parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

/**
 * Extract normalized prose from a TowerMessage `assistant` payload's content blocks.
 * Used to populate the Inbox last-turn cache from streaming events.
 * Skips tool_use / tool_result / thinking blocks — Inbox cards only show prose.
 */
function extractAssistantText(content: any): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return joinAssistantPreviewText(
    content.map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
  );
}

function extractAgentDraftPatchText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n');
}

export function stripAgentDraftPatchBlocks(content: any): any {
  // Hide both completed and still-streaming patch blocks. Waiting for the closing
  // fence exposed partial JSON in the transcript on slower model turns.
  const strip = (text: string) => text.replace(/```tower-agent-draft-patch\s*[\s\S]*?(?:```|$)/g, '').trimEnd();
  if (typeof content === 'string') return strip(content);
  if (!Array.isArray(content)) return content;
  return content.map((b: any) => (b?.type === 'text' && typeof b.text === 'string') ? { ...b, text: strip(b.text) } : b);
}

function sanitizeAgentDraftPatch(patch: unknown): Partial<AgentDraftArtifact> | null {
  if (!patch || typeof patch !== 'object') return null;
  const input = patch as Record<string, unknown>;
  const out: Partial<AgentDraftArtifact> = {};
  const stringKeys: Array<keyof AgentDraftArtifact> = ['face', 'name', 'levelTitle', 'role', 'firstTask', 'promotionGoal', 'templateId', 'tagline', 'promise', 'firstMission', 'worksFor', 'accountableOutcome'];
  for (const key of stringKeys) {
    const value = input[key];
    if (typeof value === 'string') out[key] = value.slice(0, key === 'role' || key === 'promise' ? 3000 : 500) as any;
  }
  const arrayKeys: Array<keyof AgentDraftArtifact> = ['capabilities', 'sourceHints', 'assumptions', 'responsibilities', 'strengths', 'needsFromUser', 'autonomousActions', 'approvalRequiredActions', 'onboardingChecks'];
  for (const key of arrayKeys) {
    const value = input[key];
    if (Array.isArray(value)) out[key] = value.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 500)).slice(0, 12) as any;
  }
  const requirements = input.capabilityRequirements;
  if (requirements && typeof requirements === 'object' && !Array.isArray(requirements)) {
    const source = requirements as Record<string, unknown>;
    const list = (key: string) => Array.isArray(source[key]) ? (source[key] as unknown[]).filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 200)).slice(0, 20) : undefined;
    out.capabilityRequirements = { required: list('required') || [], optional: list('optional'), forbidden: list('forbidden'), dataSources: list('dataSources'), externalActions: list('externalActions'), approvalConditions: list('approvalConditions') };
  }
  for (const key of ['authorityPolicy', 'toolPolicy'] as const) {
    const value = input[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = value as Record<string, unknown>;
  }
  if (Object.keys(out).length === 0) return null;
  return out;
}

function applyAgentDraftPatchesFromText(text: string): void {
  if (!text.includes('tower-agent-draft-patch')) return;
  const regex = /```tower-agent-draft-patch\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const patch = sanitizeAgentDraftPatch(parsed);
      if (patch) useAgentDraftStore.getState().updateDraft(patch);
    } catch {
      // Ignore malformed draft patch markers; normal chat rendering should continue.
    }
  }
}

/** Get session owner username from session store */
function getSessionOwnerUsername(sessionId: string): string | undefined {
  const sessions = useSessionStore.getState().sessions;
  const session = sessions.find((s) => s.id === sessionId);
  return session?.ownerUsername || localStorage.getItem('username') || undefined;
}

/** Default page size for initial message load */
const MESSAGE_PAGE_SIZE = 500;
const MOBILE_STREAM_RECOVERY_POLL_MS = 5_000;

function isRealUserMessage(m: ChatMessage): boolean {
  if (m.role !== 'user') return false;
  if (m.parentToolUseId) return false;
  if (m.content.length > 0 && m.content.every((b) => b.type === 'tool_result')) return false;
  return true;
}

function isTerminalAssistantMessage(m: ChatMessage): boolean {
  if (m.role !== 'assistant') return false;
  if (m.stopReason && m.stopReason !== 'toolUse') return true;
  if (m.stopReason === 'toolUse') return false;

  // DB reloads may not include a persisted stop reason for older rows. In that
  // case, distinguish final assistant prose from intermediate tool-use rows by
  // content shape: a completed tool_use block means one loop iteration finished,
  // not that the whole AI run is done. This prevents mobile/background recovery
  // from turning streaming off just because an intermediate tool call was saved.
  return m.content.some((b: any) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0);
}

function latestTurnHasTerminalAssistant(messages: ChatMessage[]): boolean {
  const lastUserIdx = [...messages]
    .map((m, i) => ({ m, i }))
    .reverse()
    .find(({ m }) => isRealUserMessage(m))?.i ?? -1;
  if (lastUserIdx < 0) return false;
  return messages.slice(lastUserIdx + 1).some(isTerminalAssistantMessage);
}

export const __test_latestTurnHasTerminalAssistant = latestTurnHasTerminalAssistant;

function clearRecoveredStreamingSession(sessionId: string) {
  markSessionRunIdle(sessionId, { pendingMessageCount: 0 });
  if (useChatStore.getState().sessionId === sessionId) {
    useChatStore.getState().setStreaming(false);
    useChatStore.getState().setTurnStartTime(null);
    useChatStore.getState().setPendingQuestion(null);
  }
  flushStalePendingInjectionsForIdleSession(sessionId);
}

/**
 * Parse the messages.metadata JSONB column. Postgres normally hands it back
 * already-parsed (object), but defensive for string rows / legacy paths.
 * See migration 055 + decision 2026-05-10-server-resume-prompt-hidden.md.
 */
function parseMetadata(raw: unknown): { hidden?: string; [key: string]: any } | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as any;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return null;
}

function isCompactMarkerMessage(message: ChatMessage): boolean {
  return message.role === 'system' && typeof message.id === 'string' && message.id.startsWith('compact-');
}

/**
 * Compact dividers can arrive twice: once as a live tower_message and once from
 * the DB marker saved for reload persistence. New events share markerId, but
 * older/racing events may have different ids, so also collapse near-adjacent
 * compact markers semantically.
 */
function dedupeCompactMarkers(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  let lastCompactAt = 0;
  for (const message of messages) {
    if (isCompactMarkerMessage(message)) {
      const ts = message.timestamp || 0;
      const prev = result[result.length - 1];
      const nearPreviousCompact = lastCompactAt > 0 && ts > 0 && Math.abs(ts - lastCompactAt) < 15_000;
      if (prev && isCompactMarkerMessage(prev)) continue;
      if (nearPreviousCompact) continue;
      lastCompactAt = ts || Date.now();
    }
    result.push(message);
  }
  return result;
}

function parseStoredMessageContent(content: unknown): any[] {
  if (Array.isArray(content)) return content;
  if (typeof content !== 'string') return [];
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string') return [{ type: 'text', text: parsed }];
    return [];
  } catch {
    return [{ type: 'text', text: content }];
  }
}

/** Map raw DB message to ChatMessage — no normalize here; ChatPanel normalizes lazily */
function mapStoredToChat(m: any, ownerUsername?: string): import('../stores/chat-store').ChatMessage {
  const storedUsername = typeof m.username === 'string' && m.username.trim()
    ? m.username.trim()
    : undefined;

  const metadata = parseMetadata(m.metadata);
  const usage = metadata?.usage || {};

  return {
    id: m.id,
    shortId: m.short_id || undefined,
    role: m.role,
    content: parseStoredMessageContent(m.content),
    timestamp: new Date(m.created_at).getTime(),
    updatedAt: m.updated_at ? new Date(m.updated_at).getTime() : undefined,
    completedAt: m.completed_at ? new Date(m.completed_at).getTime() : undefined,
    username: m.role === 'user' ? (storedUsername || ownerUsername) : undefined,
    parentToolUseId: m.parent_tool_use_id,
    durationMs: m.duration_ms || undefined,
    inputTokens: usage.context_input_tokens || m.input_tokens || undefined,
    outputTokens: m.output_tokens || undefined,
    reasoningTokens: usage.reasoning_tokens || undefined,
    contextWindowSize: usage.context_window_size || undefined,
    stopReason: m.stop_reason || undefined,
    // metadata: hidden flags etc. JSONB column from migration 055.
    // Postgres returns it already-parsed; only legacy/string rows need a parse.
    metadata,
  };
}

function mapStoredMessagesToChat(stored: any[], sessionId: string, ownerUsername?: string): ChatMessage[] {
  const mapped = stored.map((m: any) => {
    const message = mapStoredToChat(m, ownerUsername);
    if (message.role !== 'assistant') return message;
    const rawText = extractAgentDraftPatchText(message.content);
    applyAgentDraftPatchesFromText(rawText);
    return { ...message, content: stripAgentDraftPatchBlocks(message.content) };
  });
  return dedupeCompactMarkers(filterPendingSteerMessages(
    mapped,
    useChatStore.getState().pendingInjections[sessionId],
    useSessionStore.getState().streamingSessions.has(sessionId),
  ));
}

/**
 * Drain stale Pi mid-turn injection chips for a session that is now known idle.
 *
 * If the session is currently visible, also insert those persisted user messages
 * into the live transcript. If it is backgrounded, draining is enough: the next
 * session load/DB merge will show the persisted messages in authoritative order.
 */
function upsertSteerGroupMessage(sessionId: string, item: { id: string; text: string; username?: string | null; order?: number }) {
  const store = useChatStore.getState();
  const messages = store.messages;
  const last = messages[messages.length - 1];
  const sameTurnGroup = last?.role === 'user'
    && last.metadata?.kind === 'pi-steer-group'
    && last.metadata?.sessionId === sessionId;

  const normalizedItem = {
    id: item.id,
    text: item.text,
    order: typeof item.order === 'number' ? item.order : Number.MAX_SAFE_INTEGER,
  };

  if (sameTurnGroup) {
    store.setMessages(messages.map((m) => {
      if (m.id !== last.id) return m;
      const existingItems = Array.isArray(m.metadata?.steerItems)
        ? m.metadata.steerItems as Array<{ id: string; text: string; order?: number }>
        : (Array.isArray(m.metadata?.steerIds) ? m.metadata.steerIds : []).map((id: string, idx: number) => ({
            id,
            text: idx === 0 ? (m.content.find((block) => block.type === 'text')?.text ?? '') : '',
            order: idx,
          }));
      const merged = [...existingItems.filter((it) => it.id !== item.id), normalizedItem]
        .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
      return {
        ...m,
        content: [{ type: 'text', text: merged.map((it) => it.text).filter(Boolean).join('\n') }],
        metadata: {
          ...m.metadata,
          steerIds: merged.map((it) => it.id),
          steerItems: merged,
        },
      };
    }));
    return false;
  }

  store.addMessage({
    id: item.id,
    role: 'user',
    content: [{ type: 'text', text: item.text }],
    timestamp: Date.now(),
    username: item.username || getCurrentUsername() || (typeof window !== 'undefined' ? localStorage.getItem('username') || undefined : undefined),
    sendStatus: 'delivered',
    metadata: { kind: 'pi-steer-group', sessionId, steerIds: [item.id], steerItems: [normalizedItem] },
  });
  return true;
}

function flushStalePendingInjectionsForIdleSession(sessionId: string) {
  const leftover = useChatStore.getState().drainPendingInjections(sessionId);
  if (leftover.length === 0) return;

  const isCurrent = sessionId === useChatStore.getState().sessionId;
  if (!isCurrent) return;

  const currentIds = new Set(useChatStore.getState().messages.flatMap((m) => [m.id, ...(Array.isArray(m.metadata?.steerIds) ? m.metadata.steerIds : [])]));
  for (const [order, it] of leftover.entries()) {
    if (currentIds.has(it.id)) continue;
    currentIds.add(it.id);
    upsertSteerGroupMessage(sessionId, { ...it, order });
  }
}

/** Recover messages from DB for the active session (paginated — most recent N) */
export async function __test_recoverMessagesFromDb(sessionId: string) {
  try {
    const tk = localStorage.getItem('token');
    const hdrs: Record<string, string> = {};
    if (tk) hdrs['Authorization'] = `Bearer ${tk}`;
    const res = await fetch(`/api/sessions/${sessionId}/messages?limit=${MESSAGE_PAGE_SIZE}`, { headers: hdrs });
    if (res.ok) {
      const data = await res.json();
      const stored = data.messages ?? data; // backward compat: if backend returns flat array
      const hasMore = data.hasMore ?? false;
      const oldestId = data.oldestId ?? null;
      const store = useChatStore.getState();
      if ((store.sessionId && store.sessionId !== sessionId) || useSessionStore.getState().activeSessionId !== sessionId) return;
      if (stored.length > 0) {
        const ownerUsername = getSessionOwnerUsername(sessionId);
        const msgs = mapStoredMessagesToChat(stored, sessionId, ownerUsername);
        store.setMessages(msgs);
      }
      store.setHasMoreMessages(hasMore);
      store.setOldestMessageId(oldestId);
    }
  } catch (err) {
    console.warn('[recoverMessagesFromDb] failed:', err);
  }
}

/** Load older messages (prepend to existing) */
async function loadMoreMessages(sessionId: string): Promise<void> {
  const store = useChatStore.getState();
  if (store.sessionId !== sessionId || useSessionStore.getState().activeSessionId !== sessionId) return;
  if (store.loadingMoreMessages || !store.hasMoreMessages || !store.oldestMessageId) return;

  store.setLoadingMoreMessages(true);
  try {
    const tk = localStorage.getItem('token');
    const hdrs: Record<string, string> = {};
    if (tk) hdrs['Authorization'] = `Bearer ${tk}`;
    const res = await fetch(
      `/api/sessions/${sessionId}/messages?limit=${MESSAGE_PAGE_SIZE}&before=${store.oldestMessageId}`,
      { headers: hdrs }
    );
    if (res.ok) {
      const data = await res.json();
      const destinationStore = useChatStore.getState();
      if (destinationStore.sessionId !== sessionId || useSessionStore.getState().activeSessionId !== sessionId) return;
      const stored = data.messages ?? [];
      if (stored.length > 0) {
        const ownerUsername = getSessionOwnerUsername(sessionId);
        const older = stored.map((m: any) => mapStoredToChat(m, ownerUsername));
        store.setMessages(dedupeCompactMarkers([...older, ...store.messages]));
        store.setOldestMessageId(data.oldestId ?? null);
      }
      store.setHasMoreMessages(data.hasMore ?? false);
    }
  } catch (err) {
    console.warn('[loadMoreMessages] failed:', err);
  } finally {
    useChatStore.getState().setLoadingMoreMessages(false);
  }
}

/**
 * Cheap heuristic: returns true only when the merge produced no observable
 * change (same length, same first/last ids, AND same last-message content
 * shape). Skipping setMessages in that case avoids triggering a full Virtuoso
 * re-measure + every-message re-render on every reconnect when nothing changed.
 *
 * Why the last-message content check matters:
 * The earlier version compared length + first/last ids only. That broke the
 * "live session, briefly backgrounded" case on mobile: backend keeps streaming
 * tokens into the DB while the WS is dead, but the UI's last assistant message
 * has the same id and the message count hasn't changed. The naive guard then
 * skipped setMessages and the user saw a frozen reply ("업데이트가 안 됨").
 * Including a content length check on the last message catches that case
 * cheaply without paying for full deep-equal.
 */
function mergeProducesNoChange(prev: ChatMessage[], next: ChatMessage[]): boolean {
  if (prev.length !== next.length) return false;
  if (prev.length === 0) return true;
  const last = prev.length - 1;
  if (prev[0].id !== next[0].id || prev[last].id !== next[last].id) return false;

  // Last-message content sanity check. Streaming gap-recovery overwhelmingly
  // affects the *last* assistant message's content (more blocks appended, or
  // the trailing text block grew). If either changed, the merge is meaningful.
  const prevC = Array.isArray(prev[last].content) ? prev[last].content : [];
  const nextC = Array.isArray(next[last].content) ? next[last].content : [];
  if (prevC.length !== nextC.length) return false;
  if (prevC.length > 0) {
    const pb: any = prevC[prevC.length - 1];
    const nb: any = nextC[nextC.length - 1];
    const pt = typeof pb?.text === 'string' ? pb.text : '';
    const nt = typeof nb?.text === 'string' ? nb.text : '';
    if (pt.length !== nt.length) return false;
  }
  return true;
}

/**
 * Merge DB messages into current UI messages (for streaming gap recovery).
 *
 * Performance: this runs on every WS reconnect and on session-switch acks,
 * which fire heavily on mobile (visibility-change → zombie WS check → reconnect).
 * Two safeguards make the warm-path (tab refocus) cheap:
 *   1. requestIdleCallback defer — let the visibility handler paint first,
 *      then do the fetch/parse/merge during browser idle time.
 *   2. Paginated fetch (?limit=MESSAGE_PAGE_SIZE) — match the cold-path
 *      __test_recoverMessagesFromDb behaviour. Without limit, sessions with
 *      thousands of messages re-download + re-parse the entire history on
 *      every reconnect, blocking main thread for seconds on mobile.
 *
 * See: workspace/decisions/2026-05-09-mobile-warm-path-rerender.md
 */
async function mergeMessagesFromDb(sessionId: string) {
  const runMerge = async () => {
    try {
      const tk = localStorage.getItem('token');
      const hdrs: Record<string, string> = {};
      if (tk) hdrs['Authorization'] = `Bearer ${tk}`;
      const res = await fetch(
        `/api/sessions/${sessionId}/messages?limit=${MESSAGE_PAGE_SIZE}`,
        { headers: hdrs }
      );
      if (!res.ok) return;
      const body = await res.json();
      // Backend returns { messages, hasMore, oldestId } when limit param is sent;
      // fall back to flat array for older builds during rolling deploys.
      const stored: any[] = Array.isArray(body) ? body : (body.messages ?? []);
      if (stored.length === 0) return;

      const ownerUsername = getSessionOwnerUsername(sessionId);
      const dbMsgs: ChatMessage[] = mapStoredMessagesToChat(stored, sessionId, ownerUsername);

      const currentStore = useChatStore.getState();
      if (currentStore.sessionId !== sessionId || useSessionStore.getState().activeSessionId !== sessionId) return;
      const currentMsgs = currentStore.messages;
      const currentIds = new Set(currentMsgs.map((m) => m.id));

      // 스트리밍 중인 메시지 ID를 보호 목록에 추가 (DB는 UI보다 뒤처질 수 있음)
      const isStreaming = useChatStore.getState().isStreaming;
      const lastAssistantId = isStreaming
        ? currentMsgs.findLast((m) => m.role === 'assistant')?.id
        : undefined;

      // Build merged list: start with DB messages (authoritative order),
      // update content for existing ones, add missing ones
      const merged: ChatMessage[] = dbMsgs.map((dbMsg: ChatMessage) => {
        if (currentIds.has(dbMsg.id)) {
          const uiMsg = currentMsgs.find((m) => m.id === dbMsg.id)!;
          // 스트리밍 중인 마지막 assistant 메시지는 *원래* UI 가 더 최신이라
          // 가정해서 보호했었음. 하지만 mobile 의 "live session 중 백그라운드
          // 잠깐 → 복귀" 케이스에선 정반대: WS 가 끊긴 동안 backend SDK 가
          // token 을 DB 에 계속 저장 → DB 가 backlog 보유. 그래서 둘 중
          // 더 *긴* content 를 신뢰. 이게 모바일에서 "업데이트가 안 됨" 의
          // 정확한 원인이었음.
          if (isStreaming && dbMsg.id === lastAssistantId) {
            const ui = Array.isArray(uiMsg.content) ? uiMsg.content : [];
            const db = Array.isArray(dbMsg.content) ? dbMsg.content : [];
            if (db.length > ui.length) {
              return { ...uiMsg, content: dbMsg.content };
            }
            if (db.length === ui.length && db.length > 0) {
              const ub: any = ui[ui.length - 1];
              const dbb: any = db[db.length - 1];
              const ut = typeof ub?.text === 'string' ? ub.text : '';
              const dt = typeof dbb?.text === 'string' ? dbb.text : '';
              if (dt.length > ut.length) {
                return { ...uiMsg, content: dbMsg.content };
              }
            }
            // 그 외엔 UI 가 같거나 더 최신 — 기존처럼 UI 유지
            return uiMsg;
          }
          // Keep UI version but update content from DB (DB may be more complete)
          return { ...uiMsg, content: dbMsg.content };
        }
        return dbMsg;
      });

      // Append UI-only messages that are *newer than the DB window*. We only
      // fetched the last MESSAGE_PAGE_SIZE (500) DB messages, so any UI msg
      // whose id is missing from dbIds could be either:
      //   (a) a genuinely in-flight client-side message (system notice,
      //       in-flight streaming) — keep it, OR
      //   (b) an OLDER cached message that fell outside the pagination window
      //       — appending would visually duplicate ancient history at the END
      //       of the list ("마지막 메시지 뒤에 과거 메시지가 이어붙여지는"
      //       exact symptom reported on mobile).
      // Distinguish by timestamp: only append if newer than the newest DB msg.
      const dbIds = new Set(dbMsgs.map((m) => m.id));
      const dbMaxTs = dbMsgs.reduce(
        (max, m) => Math.max(max, m.timestamp || 0),
        0
      );
      for (const uiMsg of currentMsgs) {
        if (!dbIds.has(uiMsg.id) && (uiMsg.timestamp || 0) > dbMaxTs) {
          merged.push(uiMsg);
        }
      }

      // Skip the store update entirely when merge is a no-op. Without this,
      // every reconnect produces a fresh array reference → mergedMessages
      // useMemo recomputes → Virtuoso treats every item as changed → full
      // re-render. On mobile this is the main "white screen on tab return"
      // contributor.
      const dedupedMerged = dedupeCompactMarkers(merged);
      if (mergeProducesNoChange(currentMsgs, dedupedMerged)) return;

      const destinationStore = useChatStore.getState();
      if (destinationStore.sessionId !== sessionId || useSessionStore.getState().activeSessionId !== sessionId) return;
      destinationStore.setMessages(dedupedMerged);
    } catch (err) {
      console.warn('[mergeMessagesFromDb] failed:', err);
    }
  };

  // Yield to the browser so the visibility handler can finish (paint, scroll
  // restore, sidebar refresh) before we do the heavy fetch+parse+merge.
  // Falls back to setTimeout(0) on Safari < 16.4 / older mobile WebViews
  // where requestIdleCallback isn't implemented.
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => { void runMerge(); }, { timeout: 1500 });
  } else {
    setTimeout(() => { void runMerge(); }, 0);
  }
}

export function useChatRuntime(wsEnabled = true) {
  const token = localStorage.getItem('token');
  const wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const wsUrl = wsEnabled ? (token ? `${wsBase}?token=${encodeURIComponent(token)}` : wsBase) : null;
  const currentAssistantMsg = useRef<ChatMessage | null>(null);
  const currentAssistantSessionRef = useRef<string | null>(null);
  const sendRef = useRef<(data: any) => void>(() => {});
  const serverEpochRef = useRef<string | null>(null);
  const lastConnectTs = useRef<number>(0);
  // Track if session was streaming before a server restart (epoch change).
  // The 'connected' handler clears isStreaming, so reconnect_result can't detect it.
  // This ref bridges the gap so DB message recovery still works.
  const serverRestartWasStreaming = useRef(false);

  const {
    addMessage, setStreaming, setSessionId, setEngineSessionId,
    setSystemInfo, setCost, setSessionStartTime,
    setTurnStartTime,
    setTurnPhase,
  } = useChatStore();

  const { setTree, setDirectoryChildren, handleFileChange } = useFileStore();

  const upsertAssistantMessage = useCallback((sessionId: string, msgId: string, parsed: any[], parentToolUseId?: string, timestamp?: number, metadata?: ChatMessage['metadata']) => {
    if (shouldResetAssistantRef(currentAssistantSessionRef.current, sessionId)) {
      currentAssistantMsg.current = null;
    }
    currentAssistantSessionRef.current = sessionId;

    if (!currentAssistantMsg.current || currentAssistantMsg.current.id !== msgId) {
      const existingMsg = useChatStore.getState().messages.find((m) => m.id === msgId);
      if (existingMsg) {
        currentAssistantMsg.current = { ...existingMsg, content: parsed };
        useChatStore.getState().updateAssistantById(msgId, parsed, timestamp);
      } else {
        const msg: ChatMessage = {
          id: msgId,
          role: 'assistant',
          content: parsed,
          timestamp: timestamp || Date.now(),
          parentToolUseId,
          metadata: metadata ?? null,
        };
        currentAssistantMsg.current = msg;
        addMessage(msg);
      }
    } else {
      currentAssistantMsg.current = { ...currentAssistantMsg.current, content: parsed };
      useChatStore.getState().updateAssistantById(currentAssistantMsg.current.id, parsed, timestamp);
    }
  }, [addMessage]);

  const applyTurnMetrics = useCallback((payload: {
    totalCost?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    reasoningTokens?: number;
    duration?: number;
    contextInputTokens?: number;
    contextOutputTokens?: number;
    contextWindowSize?: number;
    contextEstimatedTokens?: number;
    stopReason?: string;
    /** Final assistant message row that owns this turn's persisted metrics. */
    targetMessageId?: string;
    /** Candidate assistant rows that may be merged into the visible final bubble. */
    targetMessageIds?: string[];
    /** Only final turn_done metrics should be copied onto a visible chat bubble. */
    attachToMessage?: boolean;
  }) => {
    setCost({
      totalCost: payload.totalCost || 0,
      inputTokens: payload.inputTokens || 0,
      outputTokens: payload.outputTokens || 0,
      cacheCreationTokens: payload.cacheCreationTokens,
      cacheReadTokens: payload.cacheReadTokens,
      duration: payload.duration,
      contextInputTokens: payload.contextInputTokens || 0,
      contextOutputTokens: payload.contextOutputTokens || 0,
      contextWindowSize: payload.contextWindowSize || 0,
      contextEstimatedTokens: payload.contextEstimatedTokens || 0,
    });
    const turnMetrics = {
      inputTokens: payload.contextEstimatedTokens || payload.contextInputTokens || payload.inputTokens || 0,
      outputTokens: payload.contextOutputTokens || payload.outputTokens || 0,
      reasoningTokens: payload.reasoningTokens,
      contextEstimatedTokens: payload.contextEstimatedTokens,
      durationMs: payload.duration || 0,
      completedAt: Date.now(),
      stopReason: payload.stopReason as TurnMetrics['stopReason'],
    };
    useChatStore.getState().setLastTurnMetrics(turnMetrics);
    if (payload.attachToMessage) {
      const state = useChatStore.getState();
      const candidateIds = [
        ...(payload.targetMessageIds || []),
        payload.targetMessageId,
      ].filter((id): id is string => !!id);
      const existingAssistantIds = candidateIds.filter((id) => {
        const msg = state.messages.find((m) => m.id === id);
        return msg?.role === 'assistant';
      });
      const idsToUpdate = existingAssistantIds.length > 0
        ? existingAssistantIds
        : (payload.targetMessageId ? [payload.targetMessageId] : []);
      for (const id of [...new Set(idsToUpdate)]) {
        state.updateMessageMetrics(id, turnMetrics as any);
      }
    }
  }, [setCost]);

  const finishTurn = useCallback((sessionId?: string | null, engineSessionId?: string | null) => {
    if (!sessionId) return;
    setStreaming(false);
    setTurnStartTime(null);
    useChatStore.getState().setCompacting(null);
    useChatStore.getState().setPendingQuestion(null);
    markSessionRunIdle(sessionId, { pendingMessageCount: 0 });
    currentAssistantMsg.current = null;
    if (engineSessionId) {
      setEngineSessionId(engineSessionId);
    }
  }, [setEngineSessionId, setStreaming, setTurnStartTime]);

  const refreshSlashCommands = useCallback(async (sessionId?: string | null, tools?: string[], model?: string) => {
    const tk = localStorage.getItem('token');
    const hdrs: Record<string, string> = {};
    if (tk) hdrs['Authorization'] = `Bearer ${tk}`;
    const effectiveSessionId = sessionId || useChatStore.getState().sessionId;
    const session = effectiveSessionId
      ? useSessionStore.getState().sessions.find((s) => s.id === effectiveSessionId)
      : undefined;
    const params = new URLSearchParams();
    if (session?.projectId) params.set('projectId', session.projectId);
    if (session?.cwd) params.set('cwd', session.cwd);
    try {
      const r = await fetch(`/api/commands${params.toString() ? `?${params.toString()}` : ''}`, { headers: hdrs });
      const serverCmds: Array<{
        name: string;
        canonical?: string;
        aliases?: string[];
        displayName?: string;
        summary?: string;
        argumentHint?: string;
        description: string;
        source: string;
        scope?: string;
        kind?: string;
        risk?: string;
      }> = r.ok ? await r.json() : [];
      setSystemInfo({
        slashCommands: serverCmds.map((cmd) => ({
          name: cmd.name.replace(/^\//, ''),
          canonical: cmd.canonical?.replace(/^\//, ''),
          aliases: cmd.aliases?.map((alias) => alias.replace(/^\//, '')),
          displayName: cmd.displayName,
          summary: cmd.summary,
          argumentHint: cmd.argumentHint,
          description: cmd.description,
          source: cmd.source as 'commands' | 'sdk' | 'skills' | 'native' | 'workflow',
          scope: cmd.scope as 'company' | 'project' | 'personal' | 'system' | undefined,
          kind: cmd.kind as 'native' | 'skill' | 'workflow' | undefined,
          risk: cmd.risk as 'low' | 'medium' | 'high' | 'destructive' | 'external-send' | 'deploy' | undefined,
        })),
        ...(tools ? { tools } : {}),
        ...(model ? { model } : {}),
      });
    } catch {
      setSystemInfo({ slashCommands: [], ...(tools ? { tools } : {}), ...(model ? { model } : {}) });
    }
  }, [setSystemInfo]);

  const handleMessage = useCallback((data: any) => {
    syncServerClock(data?.serverNow);
    switch (data.type) {
      case 'connected': {
        // Request browser notification permission on first connect
        requestNotificationPermission();
        const newEpoch = data.serverEpoch;
        if (isServerRestarted(serverEpochRef.current, newEpoch)) {
          // Server restarted — epoch changed.
          // Preserve wasStreaming before clearing, so reconnect_result can trigger DB recovery.
          const wasStreamingBeforeRestart = useChatStore.getState().isStreaming;
          // Capture pending question BEFORE clearing, so we know whether it's safe to auto-reload.
          const hadPendingQuestion = !!useChatStore.getState().pendingQuestion;
          useChatStore.getState().setStreaming(false);
          useChatStore.getState().setTurnStartTime(null);
          useChatStore.getState().markPendingFailed();
          useChatStore.getState().setPendingQuestion(null);
          const activeAfterRestart = useChatStore.getState().sessionId;
          if (activeAfterRestart) {
            // Use 'stopped' (not 'error') — server restart is a clean interruption, not an error.
            // 'error' phase shows red dot and blocks UX; 'stopped' shows a neutral badge.
            markSessionRunFinished(activeAfterRestart, 'stopped');
          }
          // Stash flag so reconnect_result handler can recover messages from DB
          serverRestartWasStreaming.current = wasStreamingBeforeRestart;
          currentAssistantMsg.current = null;
          // Auto-reload to pick up new frontend assets deployed with this server restart.
          // If the user had something typed (pendingQuestion), show the UpdateBanner instead
          // so they don't lose their draft — they can reload when ready.
          if (!hadPendingQuestion) {
            reloadOnce('server-restarted');
          } else {
            // UpdateBanner is the single user-facing surface for a restart that
            // cannot reload immediately because a draft/question is present.
            useSettingsStore.getState().setUpdateAvailable(true, newEpoch || null);
          }
        }
        serverEpochRef.current = newEpoch || null;

        // Debounce reconnect data fetches — skip if reconnected within 10s
        // (prevents flicker from rapid WS reconnects on mobile)
        const now = Date.now();
        const timeSinceLastConnect = now - lastConnectTs.current;
        const shouldRefreshData = lastConnectTs.current === 0 || timeSinceLastConnect > 10_000;
        lastConnectTs.current = now;

        if (shouldRefreshData) {
          // Request file tree on (re)connect so sidebar doesn't stay empty
          // (send() silently drops messages before WS is OPEN)
          setTimeout(() => sendRef.current({ type: 'file_tree', showHidden: useFileStore.getState().showHidden }), 100);

          // Refresh kanban tasks on (re)connect — task_update messages may have
          // been missed during a brief disconnection (mobile bg, Cloudflare, etc.)
          setTimeout(() => sendRef.current({ type: 'task_list' }), 150);

        }

        // Restore streaming indicators with the backend-owned acceptance time.
        // Legacy servers may only send ids; in that case retain the old fallback.
        const runningSessions: string[] = data.streamingSessions || [];
        const runningRuns = new Map<string, any>((data.streamingSessionRuns || []).map((run: any) => [run.sessionId, run]));
        const runningSetForSync = new Set(runningSessions);
        if (runningSessions.length > 0) {
          for (const sid of runningSessions) {
            const startedAt = Date.parse(runningRuns.get(sid)?.turnTiming?.acceptedAt || '');
            markSessionRunActive(sid, 'preparing', Number.isFinite(startedAt) ? { startedAt } : {});
          }
          // If the active session is streaming, restore chat panel state
          const activeSid = useChatStore.getState().sessionId;
          if (activeSid && runningSessions.includes(activeSid)) {
            useChatStore.getState().setStreaming(true);
            const startedAt = Date.parse(runningRuns.get(activeSid)?.turnTiming?.acceptedAt || '');
            if (Number.isFinite(startedAt)) {
              useChatStore.getState().setTurnStartTime(startedAt);
            } else if (!useChatStore.getState().turnStartTime) {
              useChatStore.getState().setTurnStartTime(Date.now());
            }
          }
        }

        // Sync: clear streaming for sessions the frontend thinks are active but the server says aren't.
        // This prevents stuck queues when a turn finishes while the client was disconnected.
        const frontendStreamingSessions = useSessionStore.getState().streamingSessions;
        for (const sid of frontendStreamingSessions) {
          if (!runningSetForSync.has(sid)) {
            console.log(`[chat] reconnect sync: clearing stale streaming for session ${sid.slice(0, 8)}`);
            markSessionRunIdle(sid, { pendingMessageCount: 0 });
            // If this is the active session, also clear chat-store streaming
            const currentSid = useChatStore.getState().sessionId;
            if (sid === currentSid) {
              useChatStore.getState().setStreaming(false);
              useChatStore.getState().setTurnStartTime(null);
            }
            flushStalePendingInjectionsForIdleSession(sid);
          }
        }

        // Drain orphaned queues: messages queued for sessions that are no longer streaming.
        // Delayed to ensure sessions are loaded from API and WS is fully ready.
        const runningSet = new Set(runningSessions);
        setTimeout(() => {
          const allQueues = useChatStore.getState().messageQueue;
          const activeSid2 = useChatStore.getState().sessionId;
          for (const [sid, queue] of Object.entries(allQueues)) {
            if (queue.length === 0) continue;
            // Active session queue is handled by InputBox's useEffect — skip here
            if (sid === activeSid2) continue;
            // If session is still streaming, session_status handler will drain when it finishes
            if (runningSet.has(sid)) continue;
            // Orphaned queue: session not streaming, not active → send first message
            const msg = useChatStore.getState().dequeueMessage(sid);
            if (msg) {
              const session = useSessionStore.getState().sessions.find((s) => s.id === sid);
              if (!session) {
                // Session was deleted — just clear the orphaned queue
                useChatStore.getState().clearSessionQueue(sid);
                continue;
              }
              const messageId = generateUUID();
              sendRef.current({
                type: 'chat',
                message: msg,
                messageId,
                sessionId: sid,
                engineSessionId: session.engineSessionId || session.piSessionFile || session.claudeSessionId,
                cwd: session.cwd,
                model: effectiveModelForSend(sid),
              });
              markSessionRunActive(sid, 'preparing');
            }
          }
        }, 3000);
        break;
      }

      case 'reconnect_result': {
        if (data.status === 'streaming') {
          useChatStore.getState().setStreaming(true);
          const startedAt = Date.parse(data.turnTiming?.acceptedAt || '');
          if (data.sessionId) {
            markSessionRunActive(data.sessionId, 'preparing', Number.isFinite(startedAt) ? { startedAt } : {});
          }
          // Restore live timer from the authoritative turn boundary when available.
          if (Number.isFinite(startedAt)) {
            useChatStore.getState().setTurnStartTime(startedAt);
          } else if (!useChatStore.getState().turnStartTime) {
            useChatStore.getState().setTurnStartTime(Date.now());
          }
          safetyTimerFired.current = false;
          // Merge DB messages to fill any gap from disconnection
          if (data.sessionId) {
            mergeMessagesFromDb(data.sessionId);
          }
          // Restore pending question if backend has one
          const restoredPendingQuestion = normalizePendingQuestion({
            questionId: data.pendingQuestion?.questionId,
            sessionId: data.sessionId,
            questions: data.pendingQuestion?.questions,
          });
          useChatStore.getState().setPendingQuestion(restoredPendingQuestion);
          if (restoredPendingQuestion && data.sessionId) {
            useChatStore.getState().setStreaming(false);
            markSessionRunAwaitingUser(data.sessionId, restoredPendingQuestion.questionId);
          }
          // Stream silently re-attached — no toast distraction
        } else {
          // status === 'idle'
          // Check wasStreaming OR safetyTimerFired OR serverRestartWasStreaming
          // (connected handler clears isStreaming before reconnect_result arrives,
          //  so serverRestartWasStreaming bridges the gap for DB recovery)
          const wasStreaming = useChatStore.getState().isStreaming
            || safetyTimerFired.current
            || serverRestartWasStreaming.current;
          useChatStore.getState().setStreaming(false);
          useChatStore.getState().setTurnStartTime(null);
          useChatStore.getState().setPendingQuestion(null);
          if (data.sessionId) {
            if (data.durableTurnState === 'waiting_retry') {
              markSessionRunWaitingRetry(data.sessionId, data.durableTurnError || undefined);
            } else if (data.durableTurnState === 'needs_attention') {
              markSessionRunFinished(data.sessionId, 'error', { errorMessage: data.durableTurnError || undefined });
            } else {
              markSessionRunIdle(data.sessionId, { pendingMessageCount: 0 });
            }
          }
          safetyTimerFired.current = false;
          serverRestartWasStreaming.current = false;
          currentAssistantMsg.current = null;
          if (wasStreaming && data.sessionId) {
            // Was streaming but SDK finished while disconnected — recover from DB
            __test_recoverMessagesFromDb(data.sessionId);
            console.log('Response recovered');
          }

          // Auto-name retry: if session still has default name after reconnect,
          // the original sdk_done auto-name may have been missed due to disconnect.
          if (data.sessionId) {
            const msgs = useChatStore.getState().messages;
            const session = useSessionStore.getState().sessions.find((s) => s.id === data.sessionId);
            const autoNameTarget = resolveAutoNameTarget({
              doneSessionId: data.sessionId,
              activeSessionId: useSessionStore.getState().activeSessionId,
              sessionName: session?.name,
              hasUserMsg: msgs.some((m) => m.role === 'user'),
              hasAssistantMsg: msgs.some((m) => m.role === 'assistant'),
            });
            if (autoNameTarget) {
              const tk = localStorage.getItem('token');
              const hdrs: Record<string, string> = { 'Content-Type': 'application/json' };
              if (tk) hdrs['Authorization'] = `Bearer ${tk}`;
              fetch(`/api/sessions/${autoNameTarget}/auto-name`, {
                method: 'POST',
                headers: hdrs,
              })
                .then((r) => r.ok ? r.json() : null)
                .then((result) => {
                  if (result?.name) {
                    useSessionStore.getState().updateSessionMeta(autoNameTarget, { name: result.name });
                  }
                })
                .catch((err) => { console.warn('[chat] auto-name retry on reconnect failed:', err); });
            }
          }
        }
        break;
      }

      case 'set_active_session_ack': {
        // When switching TO a session that has active streaming, restore streaming state
        if (data.isStreaming) {
          useChatStore.getState().setStreaming(true);
          currentAssistantMsg.current = null;
          // Restore pending question before choosing the visible turn phase.
          // A running engine paused on AskUserQuestion should look like a user handoff,
          // not a generic spinner.
          const restoredPendingQuestion = normalizePendingQuestion({
            questionId: data.pendingQuestion?.questionId,
            sessionId: data.sessionId,
            questions: data.pendingQuestion?.questions,
          });
          useChatStore.getState().setPendingQuestion(restoredPendingQuestion);
          if (data.sessionId) {
            if (restoredPendingQuestion) {
              useChatStore.getState().setStreaming(false);
              markSessionRunAwaitingUser(data.sessionId, restoredPendingQuestion.questionId);
            } else {
              const startedAt = Date.parse(data.turnTiming?.acceptedAt || '');
              markSessionRunActive(data.sessionId, 'preparing', Number.isFinite(startedAt) ? { startedAt } : {});
              if (Number.isFinite(startedAt)) {
                useChatStore.getState().setTurnStartTime(startedAt);
              } else if (!useChatStore.getState().turnStartTime) {
                useChatStore.getState().setTurnStartTime(Date.now());
              }
            }
            mergeMessagesFromDb(data.sessionId);
          }
        } else {
          if (data.sessionId) {
            flushStalePendingInjectionsForIdleSession(data.sessionId);
          }
          // Switching to a non-streaming session — force-clear streaming state.
          // The server is authoritative: if it says this session is idle, trust it.
          // Previous guard (`!isStreaming`) caused a permanent stuck-streaming bug:
          //   1. Session A streams → isStreaming=true → user switches away
          //   2. Session A finishes → session_status:idle ignored (different currentSid)
          //   3. User returns to A → ack says idle, but guard sees isStreaming=true → skips reset
          //   4. isStreaming stuck forever — user can't send messages.
          // Fix: always reset when switching TO an idle session. If a queue-drain
          // started streaming between the switch request and this ack, the streaming
          // session_status event will re-set isStreaming=true immediately.
          useChatStore.getState().setStreaming(false);
          useChatStore.getState().setTurnStartTime(null);
          if (data.sessionId) {
            if (data.durableTurnState === 'waiting_retry') {
              markSessionRunWaitingRetry(data.sessionId, data.durableTurnError || undefined);
            } else if (data.durableTurnState === 'needs_attention') {
              markSessionRunFinished(data.sessionId, 'error', { errorMessage: data.durableTurnError || undefined });
            } else {
              markSessionRunIdle(data.sessionId, { pendingMessageCount: 0 });
            }
          }
        }
        // Restore pending question if backend has one. For a non-streaming ack this
        // should normally be null; if it exists, prefer awaiting_user over idle.
        const restoredPendingQuestion = normalizePendingQuestion({
          questionId: data.pendingQuestion?.questionId,
          sessionId: data.sessionId,
          questions: data.pendingQuestion?.questions,
        });
        useChatStore.getState().setPendingQuestion(restoredPendingQuestion);
        if (restoredPendingQuestion && data.sessionId) {
          markSessionRunAwaitingUser(data.sessionId, restoredPendingQuestion.questionId);
        }
        break;
      }

      case 'user_message': {
        // Cross-device sync: another client sent a user message to this session.
        // Some queued-message paths also echo back to the sender; avoid double
        // incrementing the sidebar badge when the optimistic local bubble already
        // exists in the active transcript.
        const chatState = useChatStore.getState();
        const curSid = chatState.sessionId;
        const exists = data.sessionId === curSid && data.message
          ? chatState.messages.some((m) => m.id === data.message.id)
          : false;
        if (data.sessionId === curSid && data.message) {
          if (!exists) {
            addMessage({
              id: data.message.id,
              role: 'user',
              content: data.message.content,
              username: data.message.username,
              timestamp: data.message.createdAt ? new Date(data.message.createdAt).getTime() : Date.now(),
            });
          } else if (data.message.username) {
            // Optimistic local bubbles can carry stale localStorage.username.
            // The server echo is authoritative because it is stamped from the verified WS token.
            useChatStore.setState((s) => ({
              messages: s.messages.map((m) => m.id === data.message.id
                ? { ...m, username: data.message.username }
                : m),
            }));
          }
          useChatStore.getState().markPendingDelivered();
        }
        // Bump sidebar updatedAt so session re-sorts, and keep the visible
        // turn-count badge live without waiting for a full /api/sessions refetch.
        if (data.sessionId && !exists) {
          const sessionStore = useSessionStore.getState();
          const current = sessionStore.sessions.find((s) => s.id === data.sessionId);
          sessionStore.updateSessionMeta(data.sessionId, {
            updatedAt: new Date().toISOString(),
            userTurnCount: (current?.userTurnCount ?? current?.turnCount ?? 0) + 1,
          });
        } else if (data.sessionId) {
          useSessionStore.getState().updateSessionMeta(data.sessionId, { updatedAt: new Date().toISOString() });
        }
        break;
      }

      // Injection fallback: the backend couldn't inject mid-turn (e.g. session
      // still in its tiny starting window) and enqueued the message for
      // end-of-turn instead. Drop the pending chip — the bubble will arrive via
      // the normal `user_message` broadcast (queue path) and be processed when
      // the current turn finishes.
      case 'user_message_queued': {
        if (data.messageId) useChatStore.getState().removePendingInjection(data.sessionId, data.messageId);
        break;
      }

      case 'skill_invoked': {
        // Persistent chat chips now carry the user-facing skill trace. Avoid a
        // duplicate bottom-right toast for the same event.
        break;
      }

      case 'command_executed': {
        const uiAction = data.uiAction;
        if (uiAction?.type === 'open_panel') {
          if (uiAction.panel === 'agents') useSettingsStore.getState().setAgentsPanelOpen(true);
          if (uiAction.panel === 'skills') useSettingsStore.getState().setSkillsBrowserOpen(true);
          if (uiAction.panel === 'tasks') {
            useSessionStore.getState().setActiveView('work');
            useSessionStore.getState().setSidebarOpen(false);
          }
        } else if (uiAction?.type === 'open_view') {
          useSessionStore.getState().setActiveView(uiAction.view);
          useSessionStore.getState().setSidebarOpen(false);
        } else if (data.action === 'open_agents_panel') {
          // Backward compatibility for older backend events.
          useSettingsStore.getState().setAgentsPanelOpen(true);
        }
        if (data.message) toastInfo(data.message);
        break;
      }

      case 'steer_cancelled': {
        if (data.messageId) {
          cancelledSteerMessageIds.add(data.messageId);
          useChatStore.getState().removePendingInjection(data.sessionId, data.messageId);
          const store = useChatStore.getState();
          if (store.messages.some((m) => m.id === data.messageId)) {
            store.setMessages(store.messages.filter((m) => m.id !== data.messageId));
          }
        }
        if (data.text) {
          window.dispatchEvent(
            new CustomEvent('restore-input-text', { detail: { text: data.text, source: 'steer-cancel' } }),
          );
        } else {
          toastInfo('steering 메시지를 취소했습니다');
        }
        break;
      }

      case 'steer_cancel_failed': {
        if (data.message) toastWarning(data.message);
        break;
      }

      case 'session_awaiting_user': {
        if (!data.sessionId) break;
        if (data.awaiting) {
          // This content-free event is broadcast globally. Keep AUQ attention visible
          // in Latest and already-open main tabs even when this browser is looking at
          // another session; the full question payload remains session-scoped.
          markSessionRunAwaitingUser(data.sessionId, data.questionId);
        } else {
          const current = useChatStore.getState().turnStateBySession[data.sessionId];
          // Ignore stale clear edges after a newer phase has already taken over.
          if (current?.phase === 'awaiting_user') {
            markSessionRunActive(data.sessionId, 'preparing', { pendingQuestionId: undefined });
          }
        }
        break;
      }

      case 'session_status': {
        // Update sidebar streaming indicators
        if (data.sessionId) {
          const isStreamingNow = data.status === 'streaming';
          const authoritativeStartedAt = Date.parse(data.turnTiming?.acceptedAt || '');
          const timingMeta = Number.isFinite(authoritativeStartedAt) ? { startedAt: authoritativeStartedAt } : {};
          const runState = useChatStore.getState().turnStateBySession[data.sessionId];
          if (isStreamingNow) {
            // Preserve the more specific AUQ phase across generic status refreshes.
            if (runState?.phase !== 'awaiting_user') markSessionRunActive(data.sessionId, 'preparing', timingMeta);
          } else if (runState?.phase !== 'awaiting_user') {
            // Engines may report idle while AskUserQuestion is intentionally suspended.
            // Only an explicit answer/timeout edge may clear the global `?` attention.
            markSessionRunIdle(data.sessionId, { pendingMessageCount: 0 });
          }
          // Bump updatedAt so sidebar re-sorts (covers background sessions too)
          useSessionStore.getState().updateSessionMeta(data.sessionId, { updatedAt: new Date().toISOString() });

          // Keep the active chat panel in sync with the authoritative per-session status.
          // Without this, the sidebar can say "idle" while tool chips still think they're running
          // because chat-store.isStreaming is a global flag that may lag after session switches.
          const currentSid = useChatStore.getState().sessionId;
          if (data.sessionId === currentSid) {
            useChatStore.getState().setStreaming(isStreamingNow);
            if (isStreamingNow) {
              const pendingQuestion = useChatStore.getState().pendingQuestion;
              let pendingQuestionId: string | null = null;
              if (pendingQuestion && pendingQuestion.sessionId === data.sessionId) {
                pendingQuestionId = pendingQuestion.questionId;
              }
              if (pendingQuestionId) {
                useChatStore.getState().setStreaming(false);
                markSessionRunAwaitingUser(data.sessionId, pendingQuestionId);
              } else {
                markSessionRunActive(data.sessionId, 'preparing', timingMeta);
                if (Number.isFinite(authoritativeStartedAt)) {
                  useChatStore.getState().setTurnStartTime(authoritativeStartedAt);
                } else if (!useChatStore.getState().turnStartTime) {
                  useChatStore.getState().setTurnStartTime(Date.now());
                }
              }
            } else if (useChatStore.getState().turnStateBySession[data.sessionId]?.phase !== 'awaiting_user') {
              useChatStore.getState().setTurnStartTime(null);
              markSessionRunIdle(data.sessionId, { pendingMessageCount: 0 });
              const pendingQuestion = useChatStore.getState().pendingQuestion;
              if (pendingQuestion?.sessionId === data.sessionId) {
                useChatStore.getState().setPendingQuestion(null);
              }
            }
          }

          // Even when the chat body/input is not mounted (file/inbox/schedule view),
          // an authoritative idle status means pending Pi steer chips are stale.
          // Previously only InputBox or sdk_done/status_check drained these, so a
          // steer sent right before navigating away could remain visible forever
          // after returning if the browser missed the later cleanup path.
          if (!isStreamingNow && data.sessionId) {
            flushStalePendingInjectionsForIdleSession(data.sessionId);
          }

          // Auto-send queued messages for BACKGROUND sessions that finish streaming.
          // Active session queue is handled by InputBox's useEffect.
          if (!isStreamingNow && data.sessionId !== currentSid) {
            const queue = useChatStore.getState().messageQueue[data.sessionId];
            if (queue && queue.length > 0) {
              const msg = useChatStore.getState().dequeueMessage(data.sessionId);
              if (msg) {
                const session = useSessionStore.getState().sessions.find((s) => s.id === data.sessionId);
                const messageId = generateUUID();
                sendRef.current({
                  type: 'chat',
                  message: msg,
                  messageId,
                  sessionId: data.sessionId,
                  engineSessionId: session?.engineSessionId || session?.piSessionFile || session?.claudeSessionId,
                  cwd: session?.cwd,
                  model: effectiveModelForSend(data.sessionId),
                });
                // Re-mark as streaming since we just sent a new message
                markSessionRunActive(data.sessionId, 'preparing');
              }
            }
          }
        }
        break;
      }

      case 'turn_stop_state': {
        if (!data.sessionId) break;
        if (data.state === 'boundary_wait') {
          const previous = useChatStore.getState().turnStateBySession[data.sessionId];
          useChatStore.getState().setTurnPhase(data.sessionId, previous?.phase || 'streaming', {
            stopRequested: true,
            stopWaitingFor: data.waitingFor,
          });
          // The composer already changes to a stopping state. Do not add a
          // second toast; the final authoritative turn_terminal event renders
          // one compact status box in the chat timeline.
        } else if (data.state === 'stopped_clean') {
          markSessionRunFinished(data.sessionId, 'stopped');
          if (data.sessionId === useChatStore.getState().sessionId) {
            useChatStore.getState().setStreaming(false);
            useChatStore.getState().setTurnStartTime(null);
          }
        } else if (data.state === 'stopped_forced') {
          markSessionRunFinished(data.sessionId, 'stopped');
          if (data.sessionId === useChatStore.getState().sessionId) {
            useChatStore.getState().setStreaming(false);
            useChatStore.getState().setTurnStartTime(null);
          }
        } else if (data.state === 'rejected') {
          const previous = useChatStore.getState().turnStateBySession[data.sessionId];
          useChatStore.getState().setTurnPhase(data.sessionId, previous?.phase || 'streaming', {
            stopRequested: false,
            stopWaitingFor: undefined,
          });
          toastWarning(data.reason === 'not_running' ? '이미 작업이 끝났습니다.' : '이 작업을 멈출 수 없습니다.');
        }
        break;
      }

      case 'session_status_check': {
        // Response to stale work guard check — server confirms actual session status
        if (data.sessionId && data.status === 'streaming') {
          const startedAt = Date.parse(data.turnTiming?.acceptedAt || '');
          markSessionRunActive(data.sessionId, 'preparing', Number.isFinite(startedAt) ? { startedAt } : {});
          if (data.sessionId === useChatStore.getState().sessionId) {
            useChatStore.getState().setStreaming(true);
            if (Number.isFinite(startedAt)) {
              useChatStore.getState().setTurnStartTime(startedAt);
            } else if (!useChatStore.getState().turnStartTime) {
              useChatStore.getState().setTurnStartTime(Date.now());
            }
          }
        } else if (data.sessionId && data.status === 'idle') {
          console.log(`[chat] stale guard: server confirmed session ${data.sessionId.slice(0, 8)} is idle, clearing streaming`);
          if (data.durableTurnState === 'waiting_retry') {
            markSessionRunWaitingRetry(data.sessionId, data.durableTurnError || undefined);
          } else if (data.durableTurnState === 'needs_attention') {
            markSessionRunFinished(data.sessionId, 'error', { errorMessage: data.durableTurnError || undefined });
          } else {
            markSessionRunIdle(data.sessionId, { pendingMessageCount: 0 });
          }
          const currentSid = useChatStore.getState().sessionId;
          if (data.sessionId === currentSid) {
            useChatStore.getState().setStreaming(false);
            useChatStore.getState().setTurnStartTime(null);
          }

          // Drain any orphan PI mid-turn injections — backend confirmed idle, so
          // they'll never be consumed by steer_delivered. Flush them into the
          // transcript so they don't get stuck as "전달 대기 중" chips.
          // See GitHub issue #37.
          flushStalePendingInjectionsForIdleSession(data.sessionId);
          // Queue drain will be triggered by InputBox's useEffect reacting to isStreaming → false
        }
        break;
      }

      case 'config_update': {
        // Admin changed model config — update stores
        if (data.models) useModelStore.getState().setAvailableModels(data.models);
        if (data.piModels) useModelStore.getState().setPiModels(data.piModels);
        if (data.localModels) useModelStore.getState().setLocalModels(data.localModels);
        if (data.defaults) useModelStore.getState().setDefaults(data.defaults);
        // If admin retired the currently-selected model, reset to default
        reconcileSelectedModel();
        break;
      }

      case 'skills_changed': {
        void refreshSlashCommands(useChatStore.getState().sessionId);
        break;
      }

      case 'present_file_intent': {
        // Viewer tabs belong to the authenticated user's browser workspace, not
        // to the currently visible chat transcript. The backend sends this on
        // the user-scoped channel so inactive sessions can add a quiet tab.
        if (data.path) {
          window.dispatchEvent(new CustomEvent('tower-present-file', {
            detail: {
              sessionId: data.sessionId,
              deliveryId: data.deliveryId,
              path: data.path,
              label: data.label,
              focus: data.focus !== false,
            },
          }));
        }
        break;
      }

      case 'turn_terminal': {
        if (!data.sessionId) break;
        useSessionStore.getState().setTurnTerminal(data.sessionId, data);
        if (data.outcome === 'completed') {
          flushPendingLastTurnText(data.sessionId);
          const existing = useSessionStore.getState().lastTurnTextBySession[data.sessionId];
          if (existing && !existing.finalized) {
            queueLastTurnText(data.sessionId, existing.text, true, undefined, true);
          }
          useSessionStore.getState().markSessionCompleted(data.sessionId);
          markSessionRunFinished(data.sessionId, 'done', { pendingMessageCount: 0 });
        } else if (data.outcome === 'stopped') {
          markSessionRunFinished(data.sessionId, 'stopped', { pendingMessageCount: 0 });
        } else if (data.outcome === 'waiting_retry') {
          markSessionRunWaitingRetry(data.sessionId, data.error);
        } else if (data.outcome === 'failed' || data.outcome === 'needs_attention') {
          markSessionRunFinished(data.sessionId, 'error', { errorMessage: data.error, pendingMessageCount: 0 });
        } else {
          markSessionRunIdle(data.sessionId, { pendingMessageCount: 0 });
        }
        break;
      }

      case 'tower_message': {
        const currentSid = useChatStore.getState().sessionId;
        const towerMsg = data.message;

        // ── Inbox last-turn cache (runs for ALL sessions, even background ones) ──
        // Must happen BEFORE the drop filter below, otherwise tower_messages for
        // non-active sessions are discarded and the Inbox has no live preview text.
        // This is what lets an Inbox card appear with the final AI response already
        // populated — instead of blank-then-REST-fetch-a-few-seconds-later.
        if (towerMsg && typeof towerMsg === 'object' && data.sessionId) {
          if (towerMsg.type === 'assistant') {
            const text = extractAssistantText(stripAgentDraftPatchBlocks(towerMsg.content));
            if (text) {
              // Pass msgId so multi-turn tool cycles accumulate text across
              // different assistant messages instead of replacing.
              queueLastTurnText(
                data.sessionId, text, false, towerMsg.msgId || undefined
              );
            }
          } else if (towerMsg.type === 'turn_terminal') {
            // A terminal cache is final only when the root turn durably completed.
            if (towerMsg.outcome === 'completed') {
              flushPendingLastTurnText(data.sessionId);
              const existing = useSessionStore.getState().lastTurnTextBySession[data.sessionId];
              if (existing && !existing.finalized) {
                queueLastTurnText(data.sessionId, existing.text, true, undefined, true);
              }
            }
          } else if (towerMsg.type === 'turn_done' || towerMsg.type === 'engine_done') {
            // Invocation/metrics boundaries are not root-turn completion authority.
          }
        }

        // Root-turn terminal facts belong to their session even when another chat
        // is currently open. Handle them before the active-session transcript
        // filter so background completions create unread attention and settle the
        // correct row's activity state.
        if (towerMsg?.type === 'turn_terminal' && data.sessionId) {
          useSessionStore.getState().setTurnTerminal(data.sessionId, towerMsg);
          if (towerMsg.outcome === 'completed') {
            useSessionStore.getState().markSessionCompleted(data.sessionId);
            markSessionRunFinished(data.sessionId, 'done', { pendingMessageCount: 0 });
          } else if (towerMsg.outcome === 'stopped') {
            markSessionRunFinished(data.sessionId, 'stopped', { pendingMessageCount: 0 });
          } else if (towerMsg.outcome === 'waiting_retry') {
            markSessionRunWaitingRetry(data.sessionId, towerMsg.error);
          } else if (towerMsg.outcome === 'failed' || towerMsg.outcome === 'needs_attention') {
            markSessionRunFinished(data.sessionId, 'error', { errorMessage: towerMsg.error, pendingMessageCount: 0 });
          } else {
            markSessionRunIdle(data.sessionId, { pendingMessageCount: 0 });
          }
          break;
        }

        if (shouldDropSessionMessage(currentSid, data.sessionId, useSessionStore.getState().activeSessionId)) return;

        useChatStore.getState().markPendingDelivered();
        if (!towerMsg || typeof towerMsg !== 'object') break;

        if (towerMsg.type === 'turn_status') {
          setSessionId(data.sessionId);
          const phase = towerMsg.phase === 'tool_running'
            ? 'tool_running'
            : towerMsg.phase === 'stalled'
              ? 'stalled'
              : towerMsg.phase === 'closing'
                ? 'closing'
                : 'streaming';
          markSessionRunActive(data.sessionId, phase, {
            activeToolUseId: towerMsg.activeToolUseId,
            activeToolName: towerMsg.activeToolName,
            activeToolId: towerMsg.activeToolUseId,
            activeToolSummary: towerMsg.activeToolName,
          });
          break;
        }

        if (towerMsg.type === 'user') {
          setSessionId(data.sessionId);
          const msgId = towerMsg.msgId || generateUUID();
          const already = useChatStore.getState().messages.some((m) => m.id === msgId);
          if (!already) {
            addMessage({
              id: msgId,
              role: 'user',
              content: normalizeContentBlocks(towerMsg.content || []),
              timestamp: towerMsg.timestamp || Date.now(),
              username: towerMsg.username || undefined,
              metadata: towerMsg.metadata ?? null,
              sendStatus: 'delivered',
            });
          }
          break;
        }

        if (towerMsg.type === 'assistant') {
          if (towerMsg.metadata?.sourceType === 'agent_report' || towerMsg.metadata?.agentReport) {
            break;
          }
          setSessionId(data.sessionId);
          const msgId = towerMsg.msgId || generateUUID();
          const cur = currentAssistantMsg.current;
          const existingBlocks = cur && cur.id === msgId
            ? cur.content
            : useChatStore.getState().messages.find((m) => m.id === msgId)?.content || [];
          const parsed = normalizeContentBlocks(stripAgentDraftPatchBlocks(towerMsg.content || []), existingBlocks);
          applyAgentDraftPatchesFromText(extractAgentDraftPatchText(towerMsg.content || []));
          const toolBlocks = parsed.filter((b) => b.type === 'tool_use' && b.toolUse);
          const lastTool = toolBlocks[toolBlocks.length - 1]?.toolUse;
          const hasToolUse = toolBlocks.length > 0;
          const activeToolSummary = lastTool ? `${getToolSummary(lastTool.name, lastTool.input)}` : undefined;
          markSessionRunActive(data.sessionId, hasToolUse ? 'tool_running' : 'streaming', {
            activeToolUseId: lastTool?.id,
            activeToolId: lastTool?.id || (lastTool && activeToolSummary ? `${lastTool.name}:${activeToolSummary}` : undefined),
            activeToolName: lastTool?.name,
            activeToolSummary,
            activeAssistantMessageId: msgId,
          });
          upsertAssistantMessage(data.sessionId, msgId, parsed, towerMsg.parentToolUseId, towerMsg.timestamp, towerMsg.metadata ?? null);
          break;
        }

        if (towerMsg.type === 'turn_done') {
          setSessionId(data.sessionId);
          // Force-apply any RAF-batched assistant content updates that may
          // still be pending. If the browser delayed/skipped the RAF callback
          // (background tab, CPU pressure, virtualization) the last cumulative
          // content for this turn would otherwise be stuck until the user
          // refreshed — see issue #46.
          useChatStore.getState().flushAssistantUpdates();
          const usage = towerMsg.usage || {};
          applyTurnMetrics({
            totalCost: usage.costUsd || 0,
            inputTokens: usage.inputTokens || 0,
            outputTokens: usage.outputTokens || 0,
            cacheCreationTokens: usage.cacheCreationTokens,
            cacheReadTokens: usage.cacheReadTokens,
            reasoningTokens: usage.reasoningTokens,
            duration: usage.durationMs,
            contextInputTokens: usage.contextInputTokens || 0,
            contextOutputTokens: usage.contextOutputTokens || 0,
            contextWindowSize: usage.contextWindowSize || 0,
            contextEstimatedTokens: usage.contextEstimatedTokens || 0,
            stopReason: usage.stopReason,
            targetMessageId: towerMsg.msgId,
            targetMessageIds: Array.isArray(towerMsg.assistantMsgIds) ? towerMsg.assistantMsgIds : undefined,
            attachToMessage: true,
          });
          break;
        }

        if (towerMsg.type === 'steer_delivered') {
          // The agent just consumed a mid-turn injection. Insert the bubble NOW,
          // at the current end of the transcript = its real injection point.
          // Fires on every client (broadcast), so it carries text + username.
          if (towerMsg.msgId) {
            const pendingBeforeDelivery = useChatStore.getState().pendingInjections[data.sessionId] || [];
            const pendingOrder = pendingBeforeDelivery.findIndex((it) => it.id === towerMsg.msgId);
            useChatStore.getState().removePendingInjection(data.sessionId, towerMsg.msgId);
            if (cancelledSteerMessageIds.has(towerMsg.msgId)) {
              break;
            }
            const already = useChatStore.getState().messages.some((m) => {
              const steerIds = Array.isArray(m.metadata?.steerIds) ? m.metadata.steerIds : [];
              return m.id === towerMsg.msgId || steerIds.includes(towerMsg.msgId);
            });
            if (!already) {
              const insertedNewGroup = upsertSteerGroupMessage(data.sessionId, {
                id: towerMsg.msgId,
                text: towerMsg.text ?? '',
                username: towerMsg.username || undefined,
                order: pendingOrder >= 0 ? pendingOrder : undefined,
              });
              if (insertedNewGroup) {
                const sessionStore = useSessionStore.getState();
                const current = sessionStore.sessions.find((s) => s.id === data.sessionId);
                sessionStore.updateSessionMeta(data.sessionId, {
                  updatedAt: new Date().toISOString(),
                  userTurnCount: (current?.userTurnCount ?? current?.turnCount ?? 0) + 1,
                });
              }
            }
          }
          break;
        }

        if (towerMsg.type === 'compact') {
          setSessionId(data.sessionId);
          const sid = useChatStore.getState().sessionId;
          if (towerMsg.phase === 'boundary' || towerMsg.phase === 'compacting') {
            useChatStore.getState().setCompacting(sid);
            if (sid) markSessionRunActive(sid, 'compacting');
          } else if (towerMsg.phase === 'done') {
            useChatStore.getState().setCompacting(null);
            if (sid) markSessionRunActive(sid, 'streaming');
            const msgs = useChatStore.getState().messages;
            const lastMsg = msgs[msgs.length - 1];
            if (!lastMsg || !isCompactMarkerMessage(lastMsg)) {
              useChatStore.getState().addMessage({
                id: towerMsg.markerId || `compact-${data.sessionId}-${Date.now()}`,
                role: 'system',
                content: [{ type: 'text', text: '✂️ 긴 대화를 정리했습니다. 이어서 진행합니다.' }],
                timestamp: Date.now(),
              });
            }
          } else if (towerMsg.phase === 'skipped') {
            // A small session can legitimately have nothing to summarize. Clear
            // compacting UI without marking the run failed; the engine continues
            // from the unchanged native Session state.
            useChatStore.getState().setCompacting(null);
            if (sid) markSessionRunActive(sid, 'streaming');
          } else if (towerMsg.phase === 'failed') {
            useChatStore.getState().setCompacting(null);
            if (sid) {
              markSessionRunFinished(sid, 'error', {
                errorMessage: '컨텍스트 자동 정리에 실패했습니다. 같은 세션에서 다시 보내면 재시도합니다.',
                pendingMessageCount: 0,
              });
            }
          }
          break;
        }

        // Terminal events (engine_done / engine_error) are intentionally
        // NOT handled here — they arrive as legacy `sdk_done` / `error` /
        // `resume_failed` frames which have richer behaviour (auto-name
        // trigger, SESSION_BUSY re-queue, per-errorCode messaging).
        break;
      }

      case 'sdk_message': {
        // Ignore messages for sessions we're not currently viewing
        const _currentSid = useChatStore.getState().sessionId;
        if (shouldDropSessionMessage(_currentSid, data.sessionId, useSessionStore.getState().activeSessionId)) return;

        // First sdk_message confirms the backend received our chat — mark pending messages as delivered
        useChatStore.getState().markPendingDelivered();

        const sdkMsg = data.data;

        // System init — may repeat each turn, only update info without resetting
        if (sdkMsg.type === 'system' && sdkMsg.subtype === 'init') {
          // Only update session IDs if we're still on the same session (or first init)
          const curSid = useChatStore.getState().sessionId;
          if (!shouldDropSessionMessage(curSid, data.sessionId, useSessionStore.getState().activeSessionId)) {
            setSessionId(data.sessionId);
            setEngineSessionId(sdkMsg.session_id);
            // Start session timer if not already set
            if (!useChatStore.getState().sessionStartTime) {
              setSessionStartTime(Date.now());
            }
          } else {
            // Stale init from a different session — ignore entirely
            return;
          }

          // Server registry is authoritative for slash commands. SDK-provided
          // slash_commands can include host-global legacy entries that are not
          // valid for the current Tower user/project, so never merge them into
          // the dropdown.
          void refreshSlashCommands(data.sessionId || curSid, sdkMsg.tools, sdkMsg.model);
          return;
        }

        // User message (tool_result from SDK) — attach result to the matching tool_use
        if (sdkMsg.type === 'user') {
          const content = sdkMsg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result' && block.tool_use_id) {
                const resultText = typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.map((c: any) => c.text || '').join('\n')
                    : JSON.stringify(block.content);
                // Also check structured tool_use_result at top level
                const structured = sdkMsg.tool_use_result;
                const finalResult = structured?.stdout || structured?.stderr
                  ? [structured.stdout, structured.stderr].filter(Boolean).join('\n')
                  : resultText;
                useChatStore.getState().attachToolResult(block.tool_use_id, finalResult);
              }
            }
          }
          return;
        }

        // Autocompact: compact_boundary fires right before compaction starts
        if (sdkMsg.type === 'system' && sdkMsg.subtype === 'compact_boundary') {
          const sid = useChatStore.getState().sessionId;
          useChatStore.getState().setCompacting(sid);
          if (sid) markSessionRunActive(sid, 'compacting');
          return;
        }

        // Autocompact: status message — 'compacting' | null
        if (sdkMsg.type === 'system' && sdkMsg.subtype === 'status') {
          const sid = useChatStore.getState().sessionId;
          const wasCompacting = useChatStore.getState().compactingSessionId !== null;
          useChatStore.getState().setCompacting(sdkMsg.status === 'compacting' ? sid : null);
          if (sid) {
            markSessionRunActive(sid, sdkMsg.status === 'compacting' ? 'compacting' : 'streaming');
          }
          // Insert compact divider when autocompact finishes (use backend markerId for dedup)
          if (wasCompacting && sdkMsg.status !== 'compacting') {
            const markerId = sdkMsg.compactMarkerId || `compact-${data.sessionId}-${Date.now()}`;
            const msgs = useChatStore.getState().messages;
            const lastMsg = msgs[msgs.length - 1];
            if (!lastMsg || !isCompactMarkerMessage(lastMsg)) {
              useChatStore.getState().addMessage({
                id: markerId,
                role: 'system',
                content: [{ type: 'text', text: '✂️ 긴 대화를 정리했습니다. 이어서 진행합니다.' }],
                timestamp: Date.now(),
              });
            }
          }
          return;
        }

        // Rate limit event — nested under rate_limit_info
        if (sdkMsg.type === 'rate_limit_event') {
          const info = sdkMsg.rate_limit_info;
          if (info && info.status !== 'allowed') {
            useChatStore.getState().setRateLimit({
              status: info.status,
              resetsAt: info.resetsAt,
              type: info.rateLimitType,
            });
          }
          return;
        }

        // Safety net: clear compacting banner when assistant message arrives
        // (SDK may not send explicit status:null after compaction)
        if (sdkMsg.type === 'assistant' && useChatStore.getState().compactingSessionId !== null) {
          useChatStore.getState().setCompacting(null);
          if (data.sessionId) markSessionRunActive(data.sessionId, 'streaming');
          // The status handler (or DB marker on next merge) handles the divider.
          // Only add a fallback marker if the last message isn't already a compact marker.
          const msgs = useChatStore.getState().messages;
          const lastMsg = msgs[msgs.length - 1];
          if (!lastMsg || !isCompactMarkerMessage(lastMsg)) {
            useChatStore.getState().addMessage({
              id: `compact-${data.sessionId}-${Date.now()}`,
              role: 'system',
              content: [{ type: 'text', text: '✂️ 긴 대화를 정리했습니다. 이어서 진행합니다.' }],
              timestamp: Date.now(),
            });
          }
        }

        // Assistant message — each new UUID gets its own message bubble
        if (sdkMsg.type === 'assistant') {
          const msgId = sdkMsg.uuid || generateUUID();
          const cur = currentAssistantMsg.current;
          const existingBlocks = cur && cur.id === msgId
            ? cur.content
            : useChatStore.getState().messages.find((m) => m.id === msgId)?.content || [];
          const parsed = normalizeContentBlocks(parseSDKMessage(sdkMsg), existingBlocks);

          const toolBlocks = parsed.filter((b) => b.type === 'tool_use' && b.toolUse);
          const lastTool = toolBlocks[toolBlocks.length - 1]?.toolUse;
          const hasToolUse = toolBlocks.length > 0;
          const activeToolSummary = lastTool ? `${getToolSummary(lastTool.name, lastTool.input)}` : undefined;
          markSessionRunActive(data.sessionId, hasToolUse ? 'tool_running' : 'streaming', {
            activeToolUseId: lastTool?.id,
            activeToolId: lastTool?.id || (lastTool && activeToolSummary ? `${lastTool.name}:${activeToolSummary}` : undefined),
            activeToolName: lastTool?.name,
            activeToolSummary,
            activeAssistantMessageId: msgId,
          });
          upsertAssistantMessage(data.sessionId, msgId, parsed, sdkMsg.parent_tool_use_id);
          return;
        }

        // Result — usage = cumulative, context = last iteration (real context window usage)
        if (sdkMsg.type === 'result') {
          const ctx = sdkMsg.context;
          const windowSize = ctx?.window_size || 0;
          const numIter = ctx?.num_iterations || 1;
          let ctxInput = ctx?.input_tokens ?? 0;
          let ctxOutput = ctx?.output_tokens ?? 0;

          // When SDK doesn't provide per-iteration data, estimate from cumulative.
          // cumulative / numIterations ≈ last iteration's input (rough but much better than raw cumulative).
          if (ctxInput === 0 && sdkMsg.usage?.input_tokens) {
            ctxInput = Math.round((sdkMsg.usage.input_tokens + (sdkMsg.usage.cache_read_input_tokens || 0) + (sdkMsg.usage.cache_creation_input_tokens || 0)) / numIter);
            ctxOutput = Math.round((sdkMsg.usage.output_tokens || 0) / numIter);
          }
          // Safety cap: context can't exceed window size
          if (windowSize > 0 && ctxInput > windowSize) {
            ctxInput = windowSize;
          }
          applyTurnMetrics({
            totalCost: sdkMsg.total_cost_usd,
            inputTokens: sdkMsg.usage?.input_tokens || 0,
            outputTokens: sdkMsg.usage?.output_tokens || 0,
            cacheCreationTokens: sdkMsg.usage?.cache_creation_input_tokens,
            cacheReadTokens: sdkMsg.usage?.cache_read_input_tokens,
            duration: sdkMsg.duration_ms,
            contextInputTokens: ctxInput,
            contextOutputTokens: ctxOutput,
            contextWindowSize: windowSize,
            stopReason: sdkMsg.stop_reason,
            targetMessageId: currentAssistantMsg.current?.id,
            attachToMessage: true,
          });
          return;
        }
        break;
      }

      case 'tool_result_attached': {
        // Backend attached a tool result (e.g. Agent/subagent done) — update in-memory state
        if (data.toolUseId) {
          useChatStore.getState().attachToolResult(data.toolUseId, data.result || '');
        }
        break;
      }

      case 'sdk_done': {
        // Force-apply any RAF-batched assistant content updates that may
        // still be pending — see issue #46. turn_done already does this for
        // the in-band path; sdk_done is the engine-level sibling and the
        // session may end through this path without a preceding turn_done
        // (errors, aborts), so we flush here too.
        useChatStore.getState().flushAssistantUpdates();

        // Sync engine resume id to session store — even for background sessions.
        // Legacy backend payload still names this claudeSessionId.
        const doneEngineSessionId = data.engineSessionId || data.claudeSessionId;
        if (doneEngineSessionId && data.sessionId) {
          useSessionStore.getState().updateSessionMeta(data.sessionId, {
            engineSessionId: doneEngineSessionId,
          });
        }

        // Defensive: the turn ended with mid-turn injections never consumed
        // (e.g. aborted before a steering opportunity). Flush them into the
        // transcript so they don't get stuck as "전달 대기 중" chips. They were
        // persisted at send time, so this just makes the live view consistent.
        if (data.sessionId) {
          flushStalePendingInjectionsForIdleSession(data.sessionId);
        }

        // Auto-name: trigger BEFORE the session drop check.
        // User may have switched away during streaming — sdk_done arrives for
        // a background session. We still want to name it.
        {
          const activeId = useSessionStore.getState().activeSessionId;
          const targetSessionId = data.sessionId || activeId;
          const session = targetSessionId
            ? useSessionStore.getState().sessions.find((s) => s.id === targetSessionId)
            : undefined;
          // For auto-name we don't need current messages — just check session name
          const autoNameTarget = resolveAutoNameTarget({
            doneSessionId: data.sessionId,
            activeSessionId: activeId,
            sessionName: session?.name,
            hasUserMsg: true,   // sdk_done means at least one exchange happened
            hasAssistantMsg: true,
          });
          if (autoNameTarget) {
            const tk = localStorage.getItem('token');
            const hdrs: Record<string, string> = { 'Content-Type': 'application/json' };
            if (tk) hdrs['Authorization'] = `Bearer ${tk}`;
            fetch(`/api/sessions/${autoNameTarget}/auto-name`, {
              method: 'POST',
              headers: hdrs,
            })
              .then((r) => r.ok ? r.json() : null)
              .then((result) => {
                if (result?.name) {
                  useSessionStore.getState().updateSessionMeta(autoNameTarget, { name: result.name });
                }
              })
              .catch((err) => { console.warn('[chat] auto-name failed:', err); });
          }
        }

        const _doneSid = useChatStore.getState().sessionId;
        const isViewingDoneSession = !shouldDropSessionMessage(_doneSid, data.sessionId, useSessionStore.getState().activeSessionId);

        // For background sessions, sdk_done only closes activity. Durable done/error
        // presentation comes from turn_terminal.
        if (data.sessionId && !isViewingDoneSession) {
          markSessionRunIdle(data.sessionId, { pendingMessageCount: 0 });
        }

        if (!isViewingDoneSession) return;

        finishTurn(data.sessionId, doneEngineSessionId);
        break;
      }

      case 'file_tree': {
        // If we already have a tree and this is a subdirectory fetch, set as children
        const currentTree = useFileStore.getState().tree;
        if (currentTree.length > 0 && data.path) {
          // Check if this path is one of the directories in the existing tree (recursive)
          const findInTree = (entries: any[], p: string): boolean => {
            for (const e of entries) {
              if (e.path === p && e.isDirectory) return true;
              if (e.children && findInTree(e.children, p)) return true;
            }
            return false;
          };
          if (findInTree(currentTree, data.path)) {
            setDirectoryChildren(data.path, data.entries);
            // Recursively re-expand children that were previously expanded
            const { expandedPaths: ep, showHidden: sh } = useFileStore.getState();
            for (const child of data.entries as any[]) {
              if (child.isDirectory && ep.has(child.path)) {
                send({ type: 'file_tree', path: child.path, showHidden: sh });
              }
            }
            break;
          }
        }
        setTree(data.entries);
        if (data.path) {
          useFileStore.getState().setTreeRoot(data.path);
        }
        // Auto-expand previously expanded directories:
        // setTree restores isExpanded flags; now fetch children for those
        const { expandedPaths, showHidden: sh2 } = useFileStore.getState();
        const expandedInThisLevel = (data.entries as any[])
          .filter((e: any) => e.isDirectory && expandedPaths.has(e.path))
          .map((e: any) => e.path);
        for (const dirPath of expandedInThisLevel) {
          send({ type: 'file_tree', path: dirPath, showHidden: sh2 });
        }
        break;
      }

      case 'file_content': {
        const fs = useFileStore.getState();
        fs.setOpenFile({
          path: data.path,
          content: data.content,
          language: data.language,
          modified: false,
          ...(data.encoding && { encoding: data.encoding }),
        });
        if (useSessionStore.getState().isMobile) {
          useSessionStore.getState().openMobileContext();
        }
        break;
      }

      case 'file_saved': {
        toastSuccess(`${data.path.split('/').pop()} saved`);
        const fs = useFileStore.getState();
        fs.markTabSavedByPath(data.path);
        if (fs.openFile && fs.openFile.path === data.path) {
          fs.markSaved();
        }
        break;
      }

      case 'file_changed': {
        handleFileChange(data.event, data.path);
        // Refresh parent directory tree for add/addDir so new files appear,
        // but ONLY if the parent directory is currently visible in the user's file tree.
        // Skipping invisible dirs prevents the sidebar from navigating away
        // (e.g. resetting to workspace root and showing .gitignore) when Claude
        // creates files outside the user's current view.
        if (data.event === 'add' || data.event === 'addDir' || data.event === 'unlink' || data.event === 'unlinkDir') {
          // Bump refreshTrigger so ProjectFileSection components auto-refresh
          useFileStore.getState().bumpRefreshTrigger();

          const parentDir = data.path.substring(0, data.path.lastIndexOf('/'));
          if (parentDir) {
            const { tree, treeRoot, showHidden } = useFileStore.getState();
            const findInTree = (entries: typeof tree, p: string): boolean => {
              for (const e of entries) {
                if (e.path === p && e.isDirectory) return true;
                if (e.children && findInTree(e.children, p)) return true;
              }
              return false;
            };
            // Send refresh only when the parent dir is currently shown in the sidebar
            const isVisible = parentDir === treeRoot || (tree.length > 0 && findInTree(tree, parentDir));
            if (isVisible) {
              sendRef.current({ type: 'file_tree', path: parentDir, showHidden });
            }
          }
        }
        const fState = useFileStore.getState();
        const openFile = fState.openFile;
        const openedTab = fState.tabs.find(t => t.path === data.path);
        const isOpenFileTarget = openFile !== null && openFile.path === data.path;
        if ((isOpenFileTarget || openedTab) && data.event === 'change') {
          const targetModified = isOpenFileTarget ? openFile!.modified : openedTab?.modified;
          if (!targetModified) {
            // No local edits — auto-reload with debounce, including inactive open tabs.
            // Keep one timer per path: AI/tool edits often touch several open
            // files in quick succession, and a single global timer would cancel
            // earlier files before they reload.
            const previousTimer = fileChangeDebounces.get(data.path);
            if (previousTimer) clearTimeout(previousTimer);
            const nextTimer = setTimeout(() => {
              fileChangeDebounces.delete(data.path);
              // Re-check state after debounce
              const cur = useFileStore.getState();
              const currentOpenFile = cur.openFile;
              const currentTab = cur.tabs.find(t => t.path === data.path);
              const isCurrentOpenFileTarget = currentOpenFile !== null && currentOpenFile.path === data.path;
              const currentTargetModified = isCurrentOpenFileTarget ? currentOpenFile!.modified : currentTab?.modified;
              if ((isCurrentOpenFileTarget || currentTab) && !currentTargetModified) {
                const token = localStorage.getItem('token');
                const headers: Record<string, string> = {};
                if (token) headers.Authorization = `Bearer ${token}`;
                fetch(`/api/files/read?path=${encodeURIComponent(data.path)}`, { headers })
                  .then(async (res) => {
                    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to reload file');
                    return res.json();
                  })
                  .then((file) => {
                    const latest = useFileStore.getState();
                    latest.updateTabContentByPath(data.path, file.content);
                  })
                  .catch(() => {
                    // Fallback keeps legacy WebSocket reload behavior for the active file.
                    if (useFileStore.getState().openFile?.path === data.path) {
                      sendRef.current({ type: 'file_read', path: data.path });
                    }
                  });
              }
            }, 500);
            fileChangeDebounces.set(data.path, nextTimer);
          } else {
            // Local edits exist — show conflict banner
            fState.setExternalChange({ path: data.path, detectedAt: Date.now() });
          }
        }
        break;
      }

      case 'git_commit': {
        if (data.commit) {
          // Silently add the commit to the version-history panel.
          // We intentionally do NOT show a toast here: auto-snapshots are
          // background bookkeeping and the notification was distracting users
          // by drawing attention (and keyboard focus) to the git panel.
          useGitStore.getState().addCommit(data.commit);
        }
        break;
      }

      case 'ask_user': {
        const curSid = useChatStore.getState().sessionId;
        const normalizedPendingQuestion = normalizePendingQuestion({
          questionId: data.questionId,
          sessionId: data.sessionId,
          questions: data.questions,
        });
        if (data.sessionId) {
          markSessionRunAwaitingUser(data.sessionId, data.questionId);
        }
        if (!shouldDropSessionMessage(curSid, data.sessionId, useSessionStore.getState().activeSessionId)) {
          useChatStore.getState().setPendingQuestion(normalizedPendingQuestion);
          useChatStore.getState().setStreaming(false);
        }
        break;
      }

      case 'ask_user_timeout': {
        const pq = useChatStore.getState().pendingQuestion;
        if (data.sessionId) {
          markSessionRunActive(data.sessionId, 'preparing', { pendingQuestionId: undefined });
        }
        if (pq && pq.questionId === data.questionId) {
          useChatStore.getState().setPendingQuestion(null);
          toastWarning('응답 대기 시간이 초과되어 AI가 채팅으로 다시 질문합니다.');
        }
        break;
      }

      case 'error': {
        // Ignore session-specific errors for sessions we're not viewing
        const _errSid = useChatStore.getState().sessionId;
        if (shouldDropSessionMessage(_errSid, data.sessionId, useSessionStore.getState().activeSessionId)) return;

        // SESSION_BUSY = backend still running → keep isStreaming true, notify user
        if (data.errorCode === 'SESSION_BUSY') {
          console.warn('[chat] SESSION_BUSY — message will be auto-sent when current turn finishes');
          toastWarning('Message queued — waiting for current response');
          if (data.sessionId) {
            markSessionRunQueued(data.sessionId);
            const activeSessionId = useChatStore.getState().sessionId;
            if (activeSessionId === data.sessionId) {
              useChatStore.getState().setStreaming(true);
              if (!useChatStore.getState().turnStartTime) {
                useChatStore.getState().setTurnStartTime(Date.now());
              }
            }
          }
          // Re-queue: broadcast a custom event so InputBox can re-queue the message
          window.dispatchEvent(new CustomEvent('session-busy-requeue'));
          break;
        }

        setStreaming(false);
        useChatStore.getState().setCompacting(null);
        const presentation = presentChatRuntimeError(data.errorCode);
        if (data.sessionId) {
          markSessionRunFinished(data.sessionId, 'error', { errorMessage: presentation.message, pendingMessageCount: 0 });
        }
        currentAssistantMsg.current = null;
        if (presentation.tone === 'warning') {
          toastWarning(presentation.message);
        } else {
          toastError(presentation.message);
        }
        // Runtime/provider diagnostics belong in logs and activity metadata, not in
        // the conversation transcript. The run-state error and one toast are the
        // single user-facing surface; the normal composer provides the recovery action.
        break;
      }

      case 'resume_failed': {
        // Resume/retry failures are diagnostic lifecycle events. Do not add a
        // second toast, transcript message, or pseudo-continuation action: the
        // normal composer already offers the real `계속 진행` follow-up.
        // Keep provider detail in backend/activity logs rather than user UI.
        break;
      }

      case 'task_sdk_message': {
        // Route kanban task SDK messages to the chat panel if viewing that session
        const currentSid = useChatStore.getState().sessionId;
        if (data.sessionId && currentSid === data.sessionId && data.sdkMessage) {
          // Re-dispatch as a regular sdk_message so existing rendering pipeline handles it
          handleMessage({ type: 'sdk_message', sessionId: data.sessionId, data: data.sdkMessage });
        }
        break;
      }

      case 'channel_ai_message': {
        // Channel AI: push messages to ChatPanel in real-time when viewing the channel AI session
        const currentSid = useChatStore.getState().sessionId;
        if (data.sessionId && currentSid === data.sessionId && data.message) {
          addMessage({
            id: data.message.id,
            role: data.message.role,
            content: data.message.content,
            timestamp: data.message.timestamp || Date.now(),
          });
        }
        break;
      }

      case 'session_created': {
        if (data.session) {
          const store = useSessionStore.getState();
          const existing = store.sessions.find(s => s.id === data.session.id);
          // Spawned, Agent-backed, and past-turn branch sessions are first-class sidebar peers
          // even though they have parentSessionId — keep this aligned with backend api.ts filtering.
          const isSidebarPeer = data.session.label === 'spawned'
            || data.session.label === 'agent'
            || data.session.label === 'conversation_branch';
          const isHiddenChild = !!data.session.parentSessionId && !isSidebarPeer;
          if (!existing && !data.session.roomId && !isHiddenChild) {
            store.addSession(data.session);
          }
        }
        break;
      }

      case 'session_cloned': {
        if (data.session) {
          // Clone is a session lifecycle event too. The initiating tab routes
          // through App.handleSelectSession after the HTTP response; sibling
          // tabs still need this WS event to materialize the clone in their
          // sidebars without a refresh. addSession is idempotent by id.
          useSessionStore.getState().addSession(data.session);
        }
        break;
      }

      case 'session_moved': {
        // Update session's projectId in the store when moved via API (e.g., by a task agent)
        if (data.sessionId) {
          useSessionStore.getState().updateSessionMeta(data.sessionId, { projectId: data.projectId ?? null });
        }
        break;
      }

      case 'task_created': {
        if (data.task) {
          const existing = useKanbanStore.getState().tasks.find(t => t.id === data.task.id);
          if (!existing) {
            useKanbanStore.getState().addTask(data.task);
          }
        }
        break;
      }

      case 'task_update': {
        const { taskId, status, sessionId: taskSessionId, progressSummary, session: taskSession, engineSessionId: taskEngineSessionId, claudeSessionId: taskClaudeSessionId, scheduledAt, scheduleCron, scheduleEnabled, workflow, worktreePath, title, projectId, cwd } = data;
        const kanban = useKanbanStore.getState();
        const existingTask = kanban.tasks.find(t => t.id === taskId);
        if (!existingTask && title) {
          kanban.addTask({
            id: taskId,
            title,
            description: data.description || '',
            cwd: cwd || taskSession?.cwd || '',
            engine: data.engine || 'pi',
            model: data.model || 'default',
            status: status || 'in_progress',
            sessionId: taskSessionId || null,
            sortOrder: 0,
            progressSummary: progressSummary || [],
            todoSnapshot: null,
            createdAt: data.createdAt || new Date().toISOString(),
            updatedAt: data.updatedAt || new Date().toISOString(),
            completedAt: data.completedAt || null,
            scheduledAt: scheduledAt || null,
            scheduleCron: scheduleCron || null,
            scheduleEnabled: scheduleEnabled ?? false,
            workflow: workflow || 'auto',
            parentTaskId: data.parentTaskId || null,
            worktreePath: worktreePath || null,
            projectId: projectId || null,
            roomId: data.roomId || null,
            triggeredBy: data.triggeredBy || null,
            roomMessageId: data.roomMessageId || null,
            userId: data.userId || null,
            creatorName: data.creatorName || null,
            reportPolicy: data.reportPolicy || 'default',
          });
        }
        useKanbanStore.getState().updateTask(taskId, {
          ...(title !== undefined && { title }),
          ...(projectId !== undefined && { projectId }),
          ...(cwd !== undefined && { cwd }),
          ...(status && { status }),
          ...(taskSessionId !== undefined && { sessionId: taskSessionId }),
          ...(progressSummary && { progressSummary }),
          ...(scheduledAt !== undefined && { scheduledAt }),
          ...(scheduleCron !== undefined && { scheduleCron }),
          ...(scheduleEnabled !== undefined && { scheduleEnabled }),
          ...(workflow !== undefined && { workflow }),
          ...(worktreePath !== undefined && { worktreePath }),
        });
        // Notify on task completion or failure. Prefer server-sent title because
        // scheduled background tasks may complete before the client has fetched
        // the newly-created task into its kanban store.
        if (status === 'done' || status === 'failed') {
          const task = useKanbanStore.getState().tasks.find(t => t.id === taskId);
          notifyTaskComplete(title || task?.title || taskId?.slice?.(0, 8) || 'task', status);
        }
        // Add task's session to session store so card click → chat navigation works
        if (taskSession && taskSessionId) {
          const existing = useSessionStore.getState().sessions.find((s) => s.id === taskSessionId);
          if (!existing) {
            useSessionStore.getState().addSession(taskSession);
          }
        }
        // Sync engine resume id to session store so resume works when clicking the session.
        const taskResumeId = taskEngineSessionId || taskClaudeSessionId;
        if (taskResumeId && taskSessionId) {
          useSessionStore.getState().updateSessionMeta(taskSessionId, {
            engineSessionId: taskResumeId,
          });
        }
        break;
      }

      // Engine hard switch landed (POST /sessions/:id/switch-engine).
      // Backend ALSO sends a `session_meta_update` with engine=toEngine, so the
      // sidebar's engine label is already covered. Here we focus on the *messages
      // list*: the orchestrator inserted a "🔀 엔진 전환" marker row right after
      // the switch, and we want it visible immediately on the active session
      // instead of waiting for the next turn / session reactivation.
      // See: workspace/decisions/2026-05-19-engine-hard-switch-design.md
      case 'engine_switched': {
        const { sessionId: switchedSid, fromEngine, toEngine } = data;
        if (!switchedSid) break;

        // Belt-and-suspenders: even though session_meta_update mirrors this,
        // apply the engine field locally first so any synchronous read after
        // this WS event sees the new engine.
        const sStore = useSessionStore.getState();
        if (sStore.sessions.some(s => s.id === switchedSid)) {
          sStore.updateSessionMeta(switchedSid, { engine: toEngine });
        }

        // Only reload messages for the *currently active* session. Inactive
        // sessions pick up the marker the next time the user opens them
        // (App.tsx prefetch / setActiveSession path).
        const activeSid = sStore.activeSessionId;
        if (activeSid === switchedSid) {
          const tk = localStorage.getItem('token');
          const hdrs: Record<string, string> = {};
          if (tk) hdrs['Authorization'] = `Bearer ${tk}`;
          fetch(`/api/sessions/${switchedSid}/messages?limit=${MESSAGE_PAGE_SIZE}`, { headers: hdrs })
            .then(r => r.ok ? r.json() : null)
            .then(body => {
              if (!body) return;
              const stored = body.messages ?? body;
              if (!Array.isArray(stored) || stored.length === 0) return;
              const ownerUsername = getSessionOwnerUsername(switchedSid);
              const msgs = mapStoredMessagesToChat(stored, switchedSid, ownerUsername);
              useChatStore.getState().setMessages(dedupeCompactMarkers(msgs));
              useChatStore.getState().setHasMoreMessages(body.hasMore ?? false);
              useChatStore.getState().setOldestMessageId(body.oldestId ?? null);
            })
            .catch((err) => console.warn('[engine_switched] message reload failed:', err));
        }

        console.log(`[engine_switched] ${switchedSid.slice(0, 8)} ${fromEngine} → ${toEngine}`);
        break;
      }

      // Backend broadcasts session metadata changes (e.g., engineSessionId from task runner)
      case 'session_meta_update': {
        const { sessionId: metaSid, updates: metaUpdates } = data;
        if (metaSid && metaUpdates) {
          const store = useSessionStore.getState();
          const existing = store.sessions.find(s => s.id === metaSid);
          if (existing) {
            // Session exists locally — update it
            store.updateSessionMeta(metaSid, metaUpdates);
          } else if (metaUpdates.visibility === 'project') {
            // Session became shared — refetch session list to pick it up
            const tk = localStorage.getItem('token');
            const hdrs: Record<string, string> = {};
            if (tk) hdrs['Authorization'] = `Bearer ${tk}`;
            fetch('/api/sessions', { headers: hdrs })
              .then(r => r.ok ? r.json() : [])
              .then(sessions => store.setSessions(sessions.filter((s: any) => !s.roomId)))
              .catch(() => {});
          }

          // AI Panel threads (room_ai_session / session_parent) are kept in a separate
          // store — mirror the update so auto-name results surface in the thread list
          // without requiring a panel refresh.
          const panelStore = useAiPanelStore.getState();
          if (panelStore.threads.some((t) => t.id === metaSid)) {
            panelStore.updateThreadMeta(metaSid, metaUpdates);
          }
        }
        break;
      }

      case 'session_refresh_needed': {
        const refreshSid = data.sessionId;
        if (!refreshSid) break;

        const token = localStorage.getItem('token');
        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        // Keep inbox/sidebar ordering fresh even when the full tower_message was too large
        // to travel over pg_notify.
        useSessionStore.getState().updateSessionMeta(refreshSid, { updatedAt: new Date().toISOString() });

        fetch(`/api/sessions/${refreshSid}/messages?limit=${MESSAGE_PAGE_SIZE}`, { headers })
          .then((r) => (r.ok ? r.json() : null))
          .then((payload) => {
            if (!payload) return;
            const stored = payload.messages ?? payload;
            if (!Array.isArray(stored) || stored.length === 0) return;

            const ownerUsername = getSessionOwnerUsername(refreshSid);
            const msgs = mapStoredMessagesToChat(stored, refreshSid, ownerUsername);

            const lastRealUserIdx = [...msgs].map((m, i) => ({ m, i })).reverse().find(({ m }) => {
              if (m.role !== 'user') return false;
              if (m.parentToolUseId) return false;
              if (m.content.length > 0 && m.content.every((b) => b.type === 'tool_result')) return false;
              return true;
            })?.i ?? -1;

            const turnMsgs = lastRealUserIdx >= 0 ? msgs.slice(lastRealUserIdx + 1) : msgs;
            const preview = joinAssistantPreviewText(
              turnMsgs
                .filter((m) => m.role === 'assistant')
                .map((m) => extractAssistantText(m.content))
            );

            if (preview) {
              useSessionStore.getState().setLastTurnText(refreshSid, preview, true);
            }

            if (useChatStore.getState().sessionId === refreshSid) {
              useChatStore.getState().setMessages(dedupeCompactMarkers(msgs));
              useChatStore.getState().setHasMoreMessages(payload.hasMore ?? false);
              useChatStore.getState().setOldestMessageId(payload.oldestId ?? null);
            }
          })
          .catch(() => {});
        break;
      }

      case 'task_list': {
        useKanbanStore.getState().setTasks(data.tasks || []);
        break;
      }

      // ── Notifications ─────────────────────────────────────────
      case 'notification': {
        const { notification: notif } = data;
        if (notif) {
          useRoomStore.getState().addNotification(notif);
          const channels = Array.isArray(notif.channels) ? notif.channels : ['in_app', 'toast'];
          if (!channels.includes('toast')) break;

          // A notification-center row may also request a transient toast, but
          // never repeat session attention on top of the context the user is
          // already viewing. The durable inline/session state is primary.
          const sessionState = useSessionStore.getState();
          const notificationSessionId = typeof notif.sessionId === 'string'
            ? notif.sessionId
            : (typeof notif.metadata?.sessionId === 'string' ? notif.metadata.sessionId : null);
          const isViewingNotificationSession = !!notificationSessionId
            && sessionState.activeView === 'chat'
            && sessionState.activeSessionId === notificationSessionId;
          if (isViewingNotificationSession) break;

          // Show toast only when the notification policy requested that channel
          // and the event belongs to a context the user is not currently viewing.
          if (notif.type === 'task.completed' || notif.type === 'task_done') {
            notifyTaskComplete(notif.body || notif.title, 'done');
          } else if (notif.type === 'task.failed' || notif.type === 'task_failed') {
            notifyTaskComplete(notif.body || notif.title, 'failed');
          } else if (notif.type === 'message.mention' || notif.type === 'mention') {
            toastInfo(`@${notif.title}`);
          } else if (notif.type === 'proactive.message' || notif.type === 'proactive') {
            const actionUrl = typeof notif.actionUrl === 'string'
              ? notif.actionUrl
              : (typeof notif.metadata?.actionUrl === 'string' ? notif.metadata.actionUrl : null);
            toastInfo(`💬 ${notif.title}`, {
              description: notif.body,
              duration: 12_000,
              ...(actionUrl ? {
                action: {
                  label: '열기',
                  onClick: () => {
                    window.history.pushState({}, '', actionUrl);
                    window.dispatchEvent(new PopStateEvent('popstate'));
                  },
                },
              } : {}),
            });
          } else if (notif.type === 'session.completed' || notif.type === 'spawn.completed') {
            toastInfo(notif.title, { description: notif.body });
          }
        }
        break;
      }

      // Cross-tab / cross-device inbox sync (added 2026-04-10).
      // When the user reads a notification in another tab, fan out the
      // read state so every other tab updates its badge without a refetch.
      case 'notification_read': {
        const { notificationId } = data;
        if (notificationId) {
          useRoomStore.getState().markNotificationRead(notificationId);
        }
        break;
      }

      case 'notification_read_all': {
        useRoomStore.getState().markAllNotificationsRead?.();
        break;
      }

      // ── Project CRUD (added 2026-04-10) ──────────────────────
      // Previously these events were missing — a new project or member
      // invite only became visible after a hard refresh. Now the backend
      // broadcasts every mutation to the project's members.
      case 'project_created': {
        const { project } = data;
        if (project) {
          const store = useProjectStore.getState();
          if (!store.projects.some((p) => p.id === project.id)) {
            store.addProject(project);
          }
        }
        break;
      }

      case 'project_updated': {
        const { project } = data;
        if (project?.id) {
          useProjectStore.getState().updateProject(project.id, project);
        }
        break;
      }

      case 'project_deleted': {
        const { projectId } = data;
        if (projectId) {
          useProjectStore.getState().removeProject(projectId);
          // Also drop any sessions belonging to that project from the sidebar.
          const sessionStore = useSessionStore.getState();
          const orphaned = sessionStore.sessions.filter((s: any) => s.projectId === projectId);
          for (const s of orphaned) sessionStore.removeSession(s.id);
        }
        break;
      }

      case 'project_member_added': {
        // Re-fetch projects: if the current user was just invited, the
        // project may not yet be in their list. Server already pushed the
        // full project object for known members; handle the invitee too.
        const { project, userId: addedUserId } = data;
        const currentUserId = Number(localStorage.getItem('userId') || '0');
        if (project && addedUserId === currentUserId) {
          const store = useProjectStore.getState();
          if (!store.projects.some((p) => p.id === project.id)) {
            store.addProject(project);
          }
        } else if (project?.id) {
          useProjectStore.getState().updateProject(project.id, project);
        }
        break;
      }

      case 'project_member_removed': {
        const { projectId, userId: removedUserId } = data;
        const currentUserId = Number(localStorage.getItem('userId') || '0');
        if (projectId && removedUserId === currentUserId) {
          // We got kicked — drop the project entirely from our sidebar.
          useProjectStore.getState().removeProject(projectId);
          const sessionStore = useSessionStore.getState();
          const orphaned = sessionStore.sessions.filter((s: any) => s.projectId === projectId);
          for (const s of orphaned) sessionStore.removeSession(s.id);
        }
        break;
      }

      case 'project_members_changed': {
        // A group was invited en-masse. Just touch the project object so
        // components that cached members will refetch.
        const { project } = data;
        if (project?.id) {
          useProjectStore.getState().updateProject(project.id, project);
        }
        break;
      }

      // ── Session lifecycle (added 2026-04-10) ─────────────────
      case 'session_deleted': {
        const { sessionId: deletedId } = data;
        if (deletedId) {
          useSessionStore.getState().removeSession(deletedId);
          // If the deleted session was the active one, clear chat store too.
          if (useChatStore.getState().sessionId === deletedId) {
            useChatStore.setState({ sessionId: null, engineSessionId: null, messages: [], turnStateBySession: {} });
          }
        }
        break;
      }

    }
  }, [addMessage, setStreaming, setSessionId, setEngineSessionId, setSystemInfo, setCost, setSessionStartTime, setTurnStartTime, setTurnPhase, setTree, setDirectoryChildren, handleFileChange, refreshSlashCommands]);

  // Reconnect handler — send session context to backend for stream re-attachment
  const handleReconnect = useCallback(() => {
    const { sessionId: sid, engineSessionId } = useChatStore.getState();
    if (sid) {
      // Foreground/app-switch recovery must not depend only on WS events. On
      // mobile the socket can look OPEN while the stream tokens that arrived in
      // the background were never delivered to this tab. Merge the DB snapshot
      // immediately, then ask the backend for authoritative running/idle state.
      void mergeMessagesFromDb(sid);
      // Delay slightly to ensure 'connected' message is processed first
      setTimeout(() => {
        sendRef.current({
          type: 'reconnect',
          sessionId: sid,
          engineSessionId: engineSessionId || undefined,
        });
      }, 50);
    }
    // Also refresh kanban tasks — task_update messages may have been lost
    // during disconnection (e.g. task completed while WS was down)
    setTimeout(() => sendRef.current({ type: 'task_list' }), 100);
  }, []);

  const { send, connected, ws: wsRef2, safetyTimerFired } = useWebSocket(wsUrl, handleMessage, handleReconnect);
  sendRef.current = send;

  useEffect(() => {
    let stopped = false;
    let inFlight = false;

    const recoverActiveStreamingSession = async () => {
      if (stopped || inFlight) return;
      const sid = useChatStore.getState().sessionId;
      if (!sid) return;
      const stillStreaming = useChatStore.getState().isStreaming
        || useSessionStore.getState().streamingSessions.has(sid);
      if (!stillStreaming) return;

      inFlight = true;
      try {
        // WebSocket can be disconnected or zombie-open on mobile. The backend
        // still persists tokens/final rows, so use HTTP as the recovery plane.
        await __test_recoverMessagesFromDb(sid);
        if (useChatStore.getState().sessionId !== sid) return;
        if (latestTurnHasTerminalAssistant(useChatStore.getState().messages)) {
          clearRecoveredStreamingSession(sid);
          return;
        }
        if (wsRef2.current?.readyState === WebSocket.OPEN) {
          sendRef.current({ type: 'check_session_status', sessionId: sid });
        }
      } finally {
        inFlight = false;
      }
    };

    const interval = window.setInterval(() => {
      const sid = useChatStore.getState().sessionId;
      const stillStreaming = !!sid && (
        useChatStore.getState().isStreaming
        || useSessionStore.getState().streamingSessions.has(sid)
      );
      if (!stillStreaming) return;
      const wsOpen = wsRef2.current?.readyState === WebSocket.OPEN;
      const visible = document.visibilityState === 'visible';
      // Avoid extra warm-path fetches while a healthy foreground WS is already
      // delivering tokens. Poll only when disconnected/backgrounded/zombie-prone.
      if (connected && wsOpen && visible) return;
      void recoverActiveStreamingSession();
    }, MOBILE_STREAM_RECOVERY_POLL_MS);

    const recoverOnReturn = () => { void recoverActiveStreamingSession(); };
    window.addEventListener('online', recoverOnReturn);
    window.addEventListener('focus', recoverOnReturn);
    document.addEventListener('visibilitychange', recoverOnReturn);

    return () => {
      stopped = true;
      window.clearInterval(interval);
      window.removeEventListener('online', recoverOnReturn);
      window.removeEventListener('focus', recoverOnReturn);
      document.removeEventListener('visibilitychange', recoverOnReturn);
    };
  }, [connected, wsRef2]);

  // Expose WS reference globally for KanbanBoard to send task_spawn/abort messages
  if (wsRef2.current) {
    (window as any).__towerWs = wsRef2.current;
    // Compatibility for older components/extensions during the transition.
    (window as any).__claudeWs = wsRef2.current;
  }

  const sendMessage = useCallback(
    (message: string, cwdOrOptions?: string | { commandTrigger?: 'slash' | 'picker' | 'natural-language'; cwd?: string; suppressUserEcho?: boolean }, maybeOptions?: { commandTrigger?: 'slash' | 'picker' | 'natural-language'; suppressUserEcho?: boolean }) => {
      const cwd = typeof cwdOrOptions === 'string' ? cwdOrOptions : cwdOrOptions?.cwd;
      const sendOptions = typeof cwdOrOptions === 'string' ? maybeOptions : cwdOrOptions;
      // Resolve sessionId: chatStore is primary, sessionStore is fallback (handles desync)
      const resolved = resolveSendSessionId(
        useChatStore.getState().sessionId,
        useSessionStore.getState().activeSessionId,
      );
      if (!resolved) {
        console.error('[chat] sendMessage: no sessionId in either store — cannot send');
        toastError('No active session. Please select or create a session.');
        return;
      }
      const activeSid = resolved.sessionId;
      if (resolved.source === 'sessionStore') {
        console.warn(`[chat] sessionId desync detected — recovering from sessionStore: ${activeSid.slice(0, 8)}`);
        useChatStore.getState().setSessionId(activeSid);
      }

      const messageId = generateUUID();
      const backendModel = effectiveModelForSend(activeSid);
      const isPiSteering =
        useSessionStore.getState().streamingSessions.has(activeSid) &&
        isPiSessionForSend(activeSid, backendModel);

      if (sendOptions?.suppressUserEcho) {
        // Background bootstrap messages (e.g. Agent Academy) should invoke the
        // engine without making it look like the user typed a slash command.
      } else if (isPiSteering) {
        // Mid-turn injection: don't insert into the transcript at input time, or
        // rapid successive messages bunch at the top. Park it as a "전달 대기 중"
        // chip; it's spliced into the transcript at its injection point when the
        // engine confirms consumption (steer_delivered). See GitHub issue #17.
        useChatStore.getState().addPendingInjection(activeSid, messageId, message);
      } else {
        // Add user message locally with pending status (AFTER sessionId check)
        addMessage({
          id: messageId,
          role: 'user',
          content: [{ type: 'text', text: message }],
          timestamp: Date.now(),
          username: getCurrentUsername() || (typeof window !== 'undefined' ? localStorage.getItem('username') || undefined : undefined),
          sendStatus: 'pending',
        });
      }

      // Bump updatedAt and, for normal sends, the visible turn-count badge
      // immediately. Pi steering increments on `steer_delivered` instead, so a
      // cancelled pending injection does not leave a stale count.
      const sessionStore = useSessionStore.getState();
      const currentSession = sessionStore.sessions.find((s) => s.id === activeSid);
      sessionStore.updateSessionMeta(activeSid, {
        updatedAt: new Date().toISOString(),
        ...(!isPiSteering && !sendOptions?.suppressUserEcho
          ? { userTurnCount: (currentSession?.userTurnCount ?? currentSession?.turnCount ?? 0) + 1 }
          : {}),
      });

      const sent = send({
        type: 'chat',
        message,
        messageId,
        sessionId: activeSid,
        engineSessionId: useChatStore.getState().engineSessionId || undefined,
        cwd,
        model: backendModel,
        commandTrigger: sendOptions?.commandTrigger,
        suppressUserEcho: sendOptions?.suppressUserEcho,
      });

      if (!sent) {
        if (!sendOptions?.suppressUserEcho) {
          if (isPiSteering) {
            // The composer already cleared optimistically. If the WebSocket frame
            // was not accepted, remove the pending chip and restore the exact text
            // so a mid-turn instruction can never disappear silently.
            useChatStore.getState().removePendingInjection(activeSid, messageId);
            window.dispatchEvent(new CustomEvent('restore-input-text', {
              detail: { text: message, source: 'steer-cancel' },
            }));
            toastError('추가 지시를 전달하지 못해 입력창으로 복원했습니다.');
          } else {
            useChatStore.getState().markPendingFailed();
            addMessage({
              id: generateUUID(),
              role: 'assistant',
              content: [{ type: 'text', text: 'WebSocket 연결이 아직 준비되지 않아 메시지를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.' }],
              timestamp: Date.now(),
              metadata: { kind: 'client_send_failed', severity: 'warning' },
            });
          }
        }
        return;
      }

      if (!isPiSteering) {
        markSessionRunActive(activeSid, 'preparing', { pendingMessageCount: 0 });
        setStreaming(true);
        setTurnStartTime(Date.now());
        useChatStore.getState().setLastTurnMetrics(null);
        currentAssistantMsg.current = null;
        // Optimistically mark the active session as streaming so sidebar, tool chips,
        // stop button, and queue behavior all agree immediately after the frame is accepted.
      }
    },
    [send, addMessage, setStreaming, setTurnStartTime]
  );

  const requestSafeStop = useCallback(() => {
    const sessionId = useChatStore.getState().sessionId;
    if (!sessionId) return;
    send({ type: 'request_turn_stop', sessionId, mode: 'force' });
    // Stop is unconditional: return the UI to idle immediately instead of
    // waiting for an active tool or model boundary.
    setStreaming(false);
    setTurnStartTime(null);
    markSessionRunFinished(sessionId, 'stopped', { pendingMessageCount: useChatStore.getState().messageQueue[sessionId]?.length || 0 });
    useChatStore.getState().setCompacting(null);
    useChatStore.getState().setPendingQuestion(null);
  }, [send, setStreaming, setTurnStartTime]);

  const abort = useCallback(() => {
    const sessionId = useChatStore.getState().sessionId;
    send({ type: 'abort', sessionId });
    // Immediately clear streaming state so the UI returns to idle mode.
    // This lets the user send a new message right after Stop without waiting
    // for the server to confirm idle via session_status.
    // If the engine is still aborting (Pi race), the backend's SESSION_BUSY
    // guard will re-queue the message automatically.
    setStreaming(false);
    setTurnStartTime(null);
    if (sessionId) {
      markSessionRunFinished(sessionId, 'stopped', { pendingMessageCount: useChatStore.getState().messageQueue[sessionId]?.length || 0 });
    }
    useChatStore.getState().setCompacting(null);
    useChatStore.getState().setPendingQuestion(null);
  }, [send, setStreaming, setTurnStartTime]);

  const setActiveSession = useCallback(
    (sessionId: string, engineSessionId?: string | null) => {
      send({ type: 'set_active_session', sessionId, engineSessionId: engineSessionId || undefined });
    },
    [send]
  );

  const requestFileTree = useCallback(
    (path?: string) => {
      send({ type: 'file_tree', path, showHidden: useFileStore.getState().showHidden });
    },
    [send]
  );

  const requestFile = useCallback(
    (path: string) => {
      send({ type: 'file_read', path });
    },
    [send]
  );

  const saveFile = useCallback(
    (path: string, content: string) => {
      send({ type: 'file_write', path, content });
    },
    [send]
  );

  const answerQuestion = useCallback(
    (questionId: string, answer: string) => {
      const chatState = useChatStore.getState();
      const sessionId = chatState.sessionId;
      const pendingQuestion = chatState.pendingQuestion?.questionId === questionId
        ? chatState.pendingQuestion
        : null;
      send({ type: 'answer_question', sessionId, questionId, answer });
      if (pendingQuestion) {
        // The backend tool result arrives after the suspended model resumes. Update
        // the visible AUQ card immediately so it never keeps spinning after submit.
        const optimisticResult = buildAskUserQuestionDisplayResult(pendingQuestion.questions, answer);
        let optimisticToolUseId: string | null = null;
        for (let messageIndex = chatState.messages.length - 1; messageIndex >= 0 && !optimisticToolUseId; messageIndex -= 1) {
          const blocks = chatState.messages[messageIndex].content;
          for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
            const block = blocks[blockIndex];
            const tool = block.toolUse;
            const kind = (tool?.name.split('.').pop() || tool?.name || '').replace(/^functions__/, '').toLowerCase();
            if (block.type === 'tool_use' && tool?.id && kind === 'askuserquestion' && !tool.result) {
              optimisticToolUseId = tool.id;
              break;
            }
          }
        }
        if (optimisticToolUseId) chatState.attachToolResult(optimisticToolUseId, optimisticResult);
      }
      useChatStore.getState().setPendingQuestion(null);
      if (sessionId) {
        useChatStore.getState().setStreaming(true);
        markSessionRunActive(sessionId, 'preparing');
        if (!useChatStore.getState().turnStartTime) {
          useChatStore.getState().setTurnStartTime(Date.now());
        }
      }
    },
    [send]
  );

  return {
    sendMessage,
    requestSafeStop,
    abort,
    setActiveSession,
    requestFileTree,
    requestFile,
    saveFile,
    answerQuestion,
    connected,
    loadMoreMessages,
  };
}

// Deprecated compatibility alias; remove after frontend callers/tests are migrated.
export const useClaudeChat = useChatRuntime;
