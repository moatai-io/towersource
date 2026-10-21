import { useCallback, useEffect, useRef } from 'react';
import { useChatStore, type ChatMessage, type CostInfo } from '../stores/chat-store';
import { useFileStore } from '../stores/file-store';
import { useModelStore } from '../stores/model-store';
import { useSessionStore, type SessionMeta } from '../stores/session-store';
import { filterPendingSteerMessages } from '../utils/pending-steer-filter';
import { cacheSessionMessages, sessionMsgCache } from '../utils/session-message-cache';
import { deriveContextMetricFromMessages } from '../utils/message-metrics';
import { getTokenUserId, lastViewedKey } from '../utils/session-restore';
import { logClientPerf, markClientPerfTrace, perfNow, startClientPerfTrace } from '../utils/client-perf';

const API_BASE = '/api';
type ContextCostPatch = Pick<CostInfo, 'contextMeasurement' | 'contextSnapshot' | 'contextInputTokens' | 'contextOutputTokens' | 'contextWindowSize' | 'contextEstimatedTokens' | 'contextCompacted'>;

function deriveContextCostFromMessages(messages: ChatMessage[], session?: SessionMeta | null): ContextCostPatch {
  const modelState = useModelStore.getState();
  const metric = deriveContextMetricFromMessages({ messages, session, models: [...modelState.availableModels, ...modelState.piModels, ...modelState.localModels] });
  if (!metric) return { contextSnapshot: undefined, contextMeasurement: undefined, contextInputTokens: 0, contextOutputTokens: 0, contextWindowSize: 0, contextEstimatedTokens: 0, contextCompacted: false };
  return { contextSnapshot: metric.contextSnapshot, contextMeasurement: undefined, contextInputTokens: metric.contextInput, contextOutputTokens: metric.contextOutput, contextWindowSize: metric.contextWindow, contextEstimatedTokens: metric.contextInput, contextCompacted: metric.contextCompacted === true };
}

function parseStoredMessageContent(content: unknown): any[] {
  if (Array.isArray(content)) return content;
  if (typeof content !== 'string') return [];
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string') return [{ type: 'text', text: parsed }];
    return [];
  } catch { return [{ type: 'text', text: content }]; }
}

function filterLivePendingSteerRows(sessionId: string, messages: ChatMessage[]): ChatMessage[] {
  return filterPendingSteerMessages(messages, useChatStore.getState().pendingInjections[sessionId], useSessionStore.getState().streamingSessions.has(sessionId));
}

interface UseSessionSelectionOptions {
  token: string | null;
  setActiveRuntimeSession: (sessionId: string, engineSessionId?: string | null) => void;
}

export function useSessionSelection({ token, setActiveRuntimeSession }: UseSessionSelectionOptions) {
  const refreshControllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
  }, []);

  const handleSelectSession = useCallback(async (session: SessionMeta, options?: { preserveNavigation?: boolean }) => {
    if (session.label === 'personal_secretary') { window.dispatchEvent(new CustomEvent('secretariat-open')); return; }
    // Archive rows are intentionally absent from the default list. Preserve their
    // metadata for the active title/tab without unarchiving the conversation.
    if (session.archived) useSessionStore.getState().mergeSessions([session]);
    // Selecting a conversation is not a request to reopen its last historical
    // present_file. Live delivery has its own session-scoped event path.
    const replayPresentFile = false;
    // v3 (2026-05-24, path B): selecting a session anywhere (sidebar, inbox,
    // kanban, restore) ensures a chat tab for it + enters chat mode
    // (activeTabId=null). openChatTab is idempotent (focuses if already open).
    // shift/middle-click "new tab" is handled by SessionItem calling openChatTab
    // with forceNew *before* this runs. See: 2026-05-22-global-multi-tab-shell.md
    useFileStore.getState().openChatTab(session.id);

    // Sidebar/inbox/kanban selections may intentionally navigate to the AI explorer.
    // Main-tab clicks should only change the central work target and preserve the top menu + sidebar pair.
    if (!options?.preserveNavigation) {
      if (useSessionStore.getState().activeView !== 'chat') {
        useSessionStore.getState().setActiveView('chat');
      }
      if (useSessionStore.getState().sidebarTab !== 'sessions') {
        useSessionStore.getState().setSidebarTab('sessions');
      }
    }

    // Skip if already on this session (but optional view switch above still runs)
    const currentId = useSessionStore.getState().activeSessionId;
    // Selecting even the already-active session should not leave a previous
    // Viewer covering its conversation. Preserve the file tabs for later use.
    useFileStore.getState().setContextPanelOpen(false);
    if (useSessionStore.getState().isMobile && useSessionStore.getState().mobileContextOpen) {
      useSessionStore.getState().finishMobileContextInChat();
    }
    if (currentId === session.id) return;
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;

    const selectStartedAt = perfNow();
    startClientPerfTrace('session-select-to-paint', session.id, {
      sessionId: session.id,
      source: 'unknown',
    });

    // Capture synchronously before clearMessages()/activeSessionId changes. Scroll
    // and Virtuoso range callbacks can be throttled behind React/rAF, so relying
    // on their latest snapshot alone loses the exact viewport during fast tab clicks.
    window.dispatchEvent(new CustomEvent('tower-capture-chat-viewport'));

    // DON'T abort streaming — let the SDK query run in the background and save to DB.
    // When user switches back, messages are loaded from DB.
    const chatStore = useChatStore.getState();
    chatStore.setStreaming(false);

    // Clear the old message list BEFORE publishing the new session id to any
    // view/store. External-store updates are not guaranteed to be observed as
    // one atomic React render; if activeSessionId/sessionId flips while the old
    // `messages` array is still present, users see a scary stale afterimage of
    // the previous session. Prefer a brief empty/skeleton state over showing the
    // wrong session's content. See GitHub issue #74.
    chatStore.setSessionLoading(true);
    useChatStore.getState().clearMessages();

    useSessionStore.getState().setActiveSessionId(session.id);
    localStorage.setItem(lastViewedKey(getTokenUserId(token)), session.id);
    useChatStore.getState().setSessionId(session.id);

    const PAGE_SIZE = 500;
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    // ── Cache hit: replace after the old session has already been cleared ──
    const cached = sessionMsgCache.get(session.id);
    if (cached && cached.length > 0) {
      markClientPerfTrace('session-select-to-paint', session.id, 'cacheReady', {
        source: 'cache-hit',
        messageCount: cached.length,
      });
      const store = useChatStore.getState();
      store.setSessionLoading(false);
      store.setMessages(cached, { replayPresentFile });
      markClientPerfTrace('session-select-to-paint', session.id, 'storeUpdated');
      store.setCost({ totalCost: 0, inputTokens: 0, outputTokens: 0, cumulativeInputTokens: 0, cumulativeOutputTokens: 0, turnCount: 0, ...deriveContextCostFromMessages(cached, session) });
      store.setRateLimit(null);
      store.setPendingQuestion(null);
      store.setLastTurnMetrics(null);
      logClientPerf('session-select-cache-hit', {
        sessionId: session.id,
        messageCount: cached.length,
        elapsedMs: Math.round(perfNow() - selectStartedAt),
      }, { thresholdMs: 250 });

      // Use optimistic engineSessionId — don't await
      const optimisticEngineSessionId = session.engineSessionId || session.piSessionFile || session.claudeSessionId || null;
      useChatStore.getState().setEngineSessionId(optimisticEngineSessionId);
      setActiveRuntimeSession(session.id, optimisticEngineSessionId);

      // Background: parallel refresh of session metadata + messages. Only one
      // selection refresh may remain active; rapid A→B→A navigation aborts the
      // superseded request instead of letting up to 500 stale rows keep parsing
      // and competing with input on the main thread.
      const refreshController = new AbortController();
      refreshControllerRef.current = refreshController;
      const refreshTimeout = setTimeout(() => refreshController.abort(), 10000);
      const refreshStartedAt = perfNow();
      Promise.all([
        fetch(`${API_BASE}/sessions/${session.id}`, { headers, signal: refreshController.signal }).then(r => r.ok ? r.json() : null),
        fetch(`${API_BASE}/sessions/${session.id}/messages?limit=${PAGE_SIZE}`, { headers, signal: refreshController.signal }).then(r => r.ok ? r.json() : null),
      ]).then(([freshSession, msgData]) => {
        logClientPerf('session-select-cache-refresh', {
          sessionId: session.id,
          messageCount: Array.isArray(msgData) ? msgData.length : (Array.isArray(msgData?.messages) ? msgData.messages.length : 0),
          elapsedMs: Math.round(perfNow() - refreshStartedAt),
        }, { thresholdMs: 800 });
        if (refreshController.signal.aborted || useSessionStore.getState().activeSessionId !== session.id || useChatStore.getState().sessionId !== session.id) return;
        // Update engineSessionId if changed
        if ((freshSession?.engineSessionId || freshSession?.piSessionFile || freshSession?.claudeSessionId) && (freshSession.engineSessionId || freshSession.piSessionFile || freshSession.claudeSessionId) !== optimisticEngineSessionId) {
          useChatStore.getState().setEngineSessionId(freshSession.engineSessionId || freshSession.piSessionFile || freshSession.claudeSessionId);
          useSessionStore.getState().updateSessionMeta(session.id, { engineSessionId: freshSession.engineSessionId || freshSession.piSessionFile || freshSession.claudeSessionId, claudeSessionId: freshSession.claudeSessionId });
        }
        // Update messages — skip setMessages if IDs haven't changed (prevents Virtuoso scroll drift)
        if (msgData) {
          const stored = msgData.messages ?? msgData;
          if (stored?.length > 0) {
            const msgs = filterLivePendingSteerRows(session.id, stored.map((m: any) => ({
              id: m.id, shortId: m.short_id || undefined, role: m.role,
              content: parseStoredMessageContent(m.content),
              timestamp: new Date(m.created_at).getTime(),
              updatedAt: m.updated_at ? new Date(m.updated_at).getTime() : undefined,
              completedAt: m.completed_at ? new Date(m.completed_at).getTime() : undefined,
              parentToolUseId: m.parent_tool_use_id,
              durationMs: m.duration_ms || undefined,
              inputTokens: m.input_tokens || undefined,
              outputTokens: m.output_tokens || undefined,
              reasoningTokens: m.metadata?.usage?.reasoning_tokens || undefined,
              contextWindowSize: m.metadata?.usage?.context_window_size || undefined,
              stopReason: m.stop_reason || undefined,
              metadata: m.metadata ?? null,
            })));
            cacheSessionMessages(session.id, msgs);

            // Replace messages when either:
            //   - IDs changed (new message appeared / order shifted), OR
            //   - the last message's content shape changed (same id but more
            //     blocks / longer trailing text → "이미 끝난 답변이 새로 작성
            //     안 되어 있던 경우" 케이스. The cache held a frozen earlier
            //     state of the same message id.)
            // Mirror of mergeProducesNoChange logic in useChatRuntime.ts (6차)
            // so this cache-hit path doesn't have the sibling defect.
            const currentMsgs = useChatStore.getState().messages;
            const currentIds = currentMsgs.map(m => m.id).join(',');
            const freshIds = msgs.map((m: any) => m.id).join(',');
            const idsChanged = currentIds !== freshIds;
            let lastContentChanged = false;
            if (!idsChanged && msgs.length > 0 && currentMsgs.length > 0) {
              const cur: any = currentMsgs[currentMsgs.length - 1];
              const fresh: any = msgs[msgs.length - 1];
              const cL = Array.isArray(cur.content) ? cur.content.length : 0;
              const fL = Array.isArray(fresh.content) ? fresh.content.length : 0;
              if (cL !== fL) {
                lastContentChanged = true;
              } else if (cL > 0) {
                const cb: any = cur.content[cL - 1];
                const fb: any = fresh.content[fL - 1];
                const ct = typeof cb?.text === 'string' ? cb.text : '';
                const ft = typeof fb?.text === 'string' ? fb.text : '';
                if (ct.length !== ft.length) lastContentChanged = true;
              }
            }
            if (idsChanged || lastContentChanged) {
              useChatStore.getState().setMessages(msgs, { replayPresentFile });
              useChatStore.getState().setCost({ totalCost: 0, inputTokens: 0, outputTokens: 0, cumulativeInputTokens: 0, cumulativeOutputTokens: 0, turnCount: 0, ...deriveContextCostFromMessages(msgs, freshSession || session) });
              useChatStore.getState().bumpScrollGeneration();
            }
            useChatStore.getState().setHasMoreMessages(msgData.hasMore ?? false);
            useChatStore.getState().setOldestMessageId(msgData.oldestId ?? null);
          }
        }
      }).catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.warn('[app] handleSelectSession cache refresh failed:', error);
      }).finally(() => {
        clearTimeout(refreshTimeout);
        if (refreshControllerRef.current === refreshController) refreshControllerRef.current = null;
      });
      return;
    }

    // ── Cache miss: clear state then fetch ──
    // Tell the backend immediately that this websocket moved to the new session.
    // Previously this happened only after `/full` returned; if the user sent a
    // first message during that gap, the backend could keep the socket subscribed
    // to the previous session's stream.
    const optimisticEngineSessionId = session.engineSessionId || session.piSessionFile || session.claudeSessionId || null;
    useChatStore.getState().setEngineSessionId(optimisticEngineSessionId);
    setActiveRuntimeSession(session.id, optimisticEngineSessionId);

    // sessionLoading drives the skeleton in ChatPanel (`messages.length === 0
    // && sessionLoading`). If the fetch below hangs (background tab throttle,
    // server restart, dropped connection) sessionLoading would be stuck true
    // forever and the user would see the skeleton until full reload — exactly
    // the "10 minutes later, skeleton never ends" symptom.
    //
    // Two safety nets:
    //   1. AbortController + 10s timeout — fetch can't hang silently.
    //   2. finally block — sessionLoading is ALWAYS reset, on every code path
    //      (success, abort, exception, non-2xx). Note: this handler already
    //      cleared the previous session before publishing the new id, so there
    //      is no stale-message frame while the cache/fetch resolves.

    const controller = new AbortController();
    refreshControllerRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const fetchStartedAt = perfNow();
      const res = await fetch(
        `${API_BASE}/sessions/${session.id}/full?limit=${PAGE_SIZE}`,
        { headers, signal: controller.signal }
      );
      const responseMs = Math.round(perfNow() - fetchStartedAt);
      if (res.ok) {
        const parseStartedAt = perfNow();
        const data = await res.json();
        const parseMs = Math.round(perfNow() - parseStartedAt);
        logClientPerf('session-select-fetch-full', {
          sessionId: session.id,
          status: res.status,
          messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
          responseMs,
          parseMs,
          elapsedMs: Math.round(perfNow() - selectStartedAt),
        }, { thresholdMs: 800 });
        // A slower session load may finish after the user has already selected
        // another tab. Never let that stale response replace the new transcript.
        if (controller.signal.aborted || useSessionStore.getState().activeSessionId !== session.id || useChatStore.getState().sessionId !== session.id) return;

        // Apply engineSessionId
        const resolvedEngineSessionId = data.session?.engineSessionId || data.session?.piSessionFile || data.session?.claudeSessionId || session.engineSessionId || session.piSessionFile || session.claudeSessionId || null;
        if (data.session?.engineSessionId || data.session?.piSessionFile || data.session?.claudeSessionId) {
          useSessionStore.getState().updateSessionMeta(session.id, {
            engineSessionId: data.session.engineSessionId || data.session.piSessionFile || data.session.claudeSessionId,
            claudeSessionId: data.session.claudeSessionId,
          });
        }
        if (resolvedEngineSessionId !== optimisticEngineSessionId) {
          useChatStore.getState().setEngineSessionId(resolvedEngineSessionId);
          setActiveRuntimeSession(session.id, resolvedEngineSessionId);
        }

        // Apply messages
        const stored = data.messages ?? [];
        if (stored.length > 0) {
          markClientPerfTrace('session-select-to-paint', session.id, 'responseParsed', {
            source: 'network',
            responseMs,
            parseMs,
            messageCount: stored.length,
          });
          const normalizeStartedAt = perfNow();
          const msgs = filterLivePendingSteerRows(session.id, stored.map((m: any) => ({
            id: m.id, shortId: m.short_id || undefined, role: m.role,
            content: parseStoredMessageContent(m.content),
            timestamp: new Date(m.created_at).getTime(),
            updatedAt: m.updated_at ? new Date(m.updated_at).getTime() : undefined,
            completedAt: m.completed_at ? new Date(m.completed_at).getTime() : undefined,
            parentToolUseId: m.parent_tool_use_id,
            durationMs: m.duration_ms || undefined,
            inputTokens: m.input_tokens || undefined,
            outputTokens: m.output_tokens || undefined,
            reasoningTokens: m.metadata?.usage?.reasoning_tokens || undefined,
            contextWindowSize: m.metadata?.usage?.context_window_size || undefined,
            stopReason: m.stop_reason || undefined,
            metadata: m.metadata ?? null,
          })));
          markClientPerfTrace('session-select-to-paint', session.id, 'messagesNormalized', {
            normalizeMs: Math.round(perfNow() - normalizeStartedAt),
          });
          cacheSessionMessages(session.id, msgs);
          useChatStore.getState().setMessages(msgs, { replayPresentFile });
          markClientPerfTrace('session-select-to-paint', session.id, 'storeUpdated');
          useChatStore.getState().setCost({ totalCost: 0, inputTokens: 0, outputTokens: 0, cumulativeInputTokens: 0, cumulativeOutputTokens: 0, turnCount: 0, ...deriveContextCostFromMessages(msgs, session) });
          useChatStore.getState().setHasMoreMessages(data.hasMore ?? false);
          useChatStore.getState().setOldestMessageId(data.oldestId ?? null);
          useChatStore.getState().setSessionLoading(false);
          clearTimeout(timeoutId);
          return;
        }
      }
    } catch (err) {
      // AbortError on timeout is expected — log differently for clarity.
      if ((err as any)?.name === 'AbortError') {
        console.warn('[app] handleSelectSession fetch timed out (10s) for session', session.id);
      } else {
        console.warn('[app] handleSelectSession load messages failed:', err);
      }
    } finally {
      clearTimeout(timeoutId);
      if (refreshControllerRef.current === controller) {
        refreshControllerRef.current = null;
        if (useSessionStore.getState().activeSessionId === session.id && useChatStore.getState().sessionId === session.id) {
          useChatStore.getState().setSessionLoading(false);
        }
      }
    }

    // No synthetic "Switched to session" bubble for empty sessions — keep the first screen clean.

  }, [setActiveRuntimeSession, token]);

  return handleSelectSession;
}
