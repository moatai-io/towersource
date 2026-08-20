import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore, type ChatMessage } from '../../stores/chat-store';
import { useSessionStore } from '../../stores/session-store';
import { useActiveSessionStreaming } from '../../hooks/useActiveSessionStreaming';
import { RunIndicator } from '../common/RunIndicator';
import { UploadProgressChip } from '../common/UploadProgressChip';
import { useActiveSessionTurnState } from '../../hooks/useActiveSessionTurnState';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { AttachmentChip } from './AttachmentChip';
import { CommandPicker, commandIdentityKey, commandNameFields, filterSlashCommands, hasExactCommandMatch as hasExactSlashCommandMatch } from './CommandPicker';
import { InputResizeHandle, INPUT_MIN_HEIGHT, INPUT_MAX_HEIGHT } from './InputResizeHandle';
import { toastInfo } from '../../utils/toast';
import { optimizeBatch, formatBytes } from '../../utils/file-optimizer';
import { uploadFileBatchWithProgress, type UploadProgressSnapshot } from '../../utils/upload-with-progress';

const EMPTY_QUEUE: string[] = [];
const EMPTY_INJECTIONS: Array<{ id: string; text: string }> = [];

type RestoreInputTextDetail = string | { text: string; source?: 'queue-cancel' | 'steer-copy' | 'steer-cancel' };

/*
 * Textarea height — 적응형 max-h:
 *   - 모바일 (<640px): 가상 키보드가 화면 절반을 먹으니 180px 캡
 *   - 태블릿 (640-1024): 400px
 *   - 데스크탑 (>1024): viewport 의 50% 또는 500px 중 작은 값
 * 사용자가 InputResizeHandle 로 manual height 를 잡으면 그 값이 우선.
 */
function getDefaultMaxHeight(): number {
  if (typeof window === 'undefined') return 200;
  const w = window.innerWidth;
  if (w < 640) return 180;
  if (w < 1024) return 400;
  return Math.min(Math.round(window.innerHeight * 0.5), 500);
}

const MANUAL_HEIGHT_KEY = 'tower:inputManualHeight';

function loadManualHeight(): number | null {
  try {
    const v = localStorage.getItem(MANUAL_HEIGHT_KEY);
    if (!v) return null;
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n >= INPUT_MIN_HEIGHT && n <= INPUT_MAX_HEIGHT) return n;
    return null;
  } catch { return null; }
}

function saveManualHeight(h: number | null) {
  try {
    if (h === null) localStorage.removeItem(MANUAL_HEIGHT_KEY);
    else localStorage.setItem(MANUAL_HEIGHT_KEY, String(h));
  } catch { /* storage full */ }
}

export interface SendOptions {
  commandTrigger?: 'slash' | 'picker' | 'natural-language';
  /** Internal/background sends should reach the backend without rendering as a user bubble. */
  suppressUserEcho?: boolean;
}

interface InputBoxProps {
  onSend: (message: string, options?: SendOptions) => void;
  onAbort: () => void;
  onSafeStop?: () => void;
  onAnswerQuestion?: (questionId: string, answer: string) => void;
  /** Jump to the previous user message (the question above the currently visible top). */
  onJumpPrevUser?: () => void;
  /** Jump to the next user message (below the currently visible top). */
  onJumpNextUser?: () => void;
  /** Whether a previous user message exists relative to the current scroll position. */
  hasPrevUser?: boolean;
  /** Whether a next user message exists relative to the current scroll position. */
  hasNextUser?: boolean;
}

const DRAFT_PREFIX = 'tower:inputDraft:';
const COLLAPSED_STEERING_LINES = 3;
const STEERING_PREVIEW_CHARS_PER_LINE = 88;

function isMacLikePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

function buildSteeringPreview(texts: string[]): { lines: string[]; hiddenLineCount: number; totalLineCount: number } {
  const lines = texts.flatMap((text) => {
    const rawLines = text.split(/\r?\n/);
    return rawLines.flatMap((line) => {
      if (line.length <= STEERING_PREVIEW_CHARS_PER_LINE) return [line];
      const chunks: string[] = [];
      for (let i = 0; i < line.length; i += STEERING_PREVIEW_CHARS_PER_LINE) {
        chunks.push(line.slice(i, i + STEERING_PREVIEW_CHARS_PER_LINE));
      }
      return chunks;
    });
  });
  return {
    lines: lines.slice(0, COLLAPSED_STEERING_LINES),
    hiddenLineCount: Math.max(0, lines.length - COLLAPSED_STEERING_LINES),
    totalLineCount: lines.length,
  };
}

function turnStatusText(phase: string, hasQueue: boolean, t: (key: string, options?: Record<string, unknown>) => string): string {
  // Phase 상태(preparing, tool_running 등)는 AssistantPlaceholder가 메시지
  // 영역에서 직접 표시. InputBox 위 박스는 큐 상태만 담당.
  if (hasQueue && phase !== 'awaiting_user') return t('queueAdded');
  return '';
}

function getDraftKey(sessionId: string | null): string {
  return sessionId ? `${DRAFT_PREFIX}${sessionId}` : `${DRAFT_PREFIX}__global`;
}

function loadDraft(sessionId: string | null): string {
  try {
    const val = localStorage.getItem(getDraftKey(sessionId));
    if (val) return val;
    // Migrate from old global key (one-time)
    const OLD_KEY = 'tower:inputDraft';
    const old = localStorage.getItem(OLD_KEY);
    if (old) {
      localStorage.removeItem(OLD_KEY);
      return old;
    }
    return '';
  } catch { return ''; }
}

function saveDraft(sessionId: string | null, value: string) {
  try {
    const key = getDraftKey(sessionId);
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* storage full */ }
}

interface AiComposerSettings {
  enabled: boolean;
  emptyDraftEnabled: boolean;
  inlineDraftEnabled: boolean;
  debounceMs: number;
  minRequestIntervalMs: number;
  responseMaxAgeMs: number;
  minDraftLength: number;
}

// Temporary client-side kill switch. The backend independently rejects stale
// clients so neither mobile nor desktop can invoke the autocomplete model.
const AI_COMPOSER_AUTOCOMPLETE_ENABLED = false;

const DEFAULT_AI_COMPOSER_SETTINGS: AiComposerSettings = {
  enabled: false,
  emptyDraftEnabled: false,
  inlineDraftEnabled: false,
  debounceMs: 500,
  minRequestIntervalMs: 5_000,
  responseMaxAgeMs: 5_000,
  minDraftLength: 4,
};

export function InputBox({ onSend, onAbort, onSafeStop, onAnswerQuestion, onJumpPrevUser, onJumpNextUser, hasPrevUser, hasNextUser }: InputBoxProps) {
  const { t } = useTranslation('chat');
  const [input, setInput] = useState('');
  const [ghostSuggestion, setGhostSuggestion] = useState('');
  const [ghostSuffix, setGhostSuffix] = useState('');
  const [composerSettings, setComposerSettings] = useState<AiComposerSettings>(DEFAULT_AI_COMPOSER_SETTINGS);
  const [showCommands, setShowCommands] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressSnapshot | null>(null);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [steerExpanded, setSteerExpanded] = useState(false);
  const selectedCommandTriggerRef = useRef<SendOptions['commandTrigger'] | null>(null);
  // 사용자가 InputResizeHandle 로 명시 지정한 높이. null = auto.
  const [manualHeight, setManualHeight] = useState<number | null>(() => loadManualHeight());
  // 모바일 분기 (placeholder 문구 + UI 분기). 미세 jitter 흡수 위해 100ms debounce.
  const isMobile = useMediaQuery('(max-width: 640px)', { debounceMs: 100 });
  const navShortcutLabel = isMacLikePlatform() ? '⌥↑ / ⌥↓' : 'Alt+↑ / Alt+↓';
  // viewport 따라 default max-h 재계산
  const [defaultMaxH, setDefaultMaxH] = useState<number>(() => getDefaultMaxHeight());
  useEffect(() => {
    const onResize = () => setDefaultMaxH(getDefaultMaxHeight());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const effectiveMaxH = manualHeight ?? defaultMaxH;
  const dragCounter = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Tab으로 채택한 자동완성은 사용자가 다시 직접 수정하기 전까지 재제안하지 않는다.
  const acceptedCompletionRef = useRef('');
  const lastAutocompleteRequestAtRef = useRef(0);
  const lastAutocompleteDraftRef = useRef<string | null>(null);
  // Hidden file picker — triggered by the attach button. Mobile entry point for
  // photos/files (drag&drop and clipboard paste are unreliable on iOS/Android,
  // so an explicit picker is the only working path on phones).
  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentSessionId = useChatStore((s) => s.sessionId);
  const activeSession = useSessionStore((s) => s.sessions.find((session) => session.id === s.activeSessionId));
  const isStreaming = useActiveSessionStreaming();
  const activeTurn = useActiveSessionTurnState();
  const pendingQuestion = useChatStore((s) => s.pendingQuestion);
  const isPiStreamingSession = isStreaming && activeSession?.engine === 'pi';
  const isSafeStopAvailable = isPiStreamingSession;
  const currentQueue = useChatStore((s) => {
    const sid = s.sessionId;
    if (!sid) return EMPTY_QUEUE;
    return s.messageQueue[sid] ?? EMPTY_QUEUE;
  });
  const hasQueue = currentQueue.length > 0;
  const pendingInjections = useChatStore((s) => {
    const sid = s.sessionId;
    if (!sid) return EMPTY_INJECTIONS;
    return s.pendingInjections[sid] ?? EMPTY_INJECTIONS;
  });
  const messages = useChatStore((s) => s.messages);
  const visiblePendingInjections = useMemo(() => {
    if (pendingInjections.length === 0) return pendingInjections;
    const ids = new Set(messages.map((m) => m.id));
    return pendingInjections.filter((it) => !ids.has(it.id));
  }, [messages, pendingInjections]);
  const pendingInjectionTexts = visiblePendingInjections.map((it) => it.text);
  const pendingInjectionText = pendingInjectionTexts.join('\n');
  const steeringPreview = useMemo(() => buildSteeringPreview(pendingInjectionTexts), [pendingInjectionTexts]);
  const steeringLayerHeight = visiblePendingInjections.length > 0
    ? (steerExpanded
      ? 64 + Math.max(steeringPreview.totalLineCount, visiblePendingInjections.length) * 20
      : Math.min(132, 64 + visiblePendingInjections.length * 24))
    : 0;
  // Keep the steering sheet connected to the composer: reserve only the visible
  // part above the input, then let the composer overlap the lower edge.
  const steeringLayerOverlap = visiblePendingInjections.length > 0 ? 28 : 0;
  const steeringLayerReservedHeight = Math.max(0, steeringLayerHeight - steeringLayerOverlap);
  useEffect(() => {
    if (!hasQueue && queueExpanded) setQueueExpanded(false);
  }, [hasQueue, queueExpanded]);
  useEffect(() => {
    if (visiblePendingInjections.length === 0 && steerExpanded) setSteerExpanded(false);
  }, [visiblePendingInjections.length, steerExpanded]);

  // Defensive cleanup: if Pi is no longer streaming but steer chips survived
  // (missed steer_delivered/sdk_done/session_status during reconnect/backgrounding),
  // they can never be consumed. Promote them into delivered transcript bubbles
  // instead of only deleting the chips; the backend persisted these messages at
  // send time, and this keeps the live view consistent when the ack frame was
  // missed or arrived while the tab was backgrounded.
  useEffect(() => {
    if (!currentSessionId || isStreaming || pendingInjections.length === 0) return;
    const leftover = useChatStore.getState().drainPendingInjections(currentSessionId);
    if (leftover.length === 0) return;
    console.log(`[chat] flushing stale Pi steer chips for idle session ${currentSessionId.slice(0, 8)} count=${leftover.length}`);
    const username = localStorage.getItem('username') || undefined;
    const additions: ChatMessage[] = [];
    const currentIds = new Set(useChatStore.getState().messages.map((m) => m.id));
    for (const it of leftover) {
      if (currentIds.has(it.id)) continue;
      currentIds.add(it.id);
      additions.push({
        id: it.id,
        role: 'user',
        content: [{ type: 'text', text: it.text }],
        timestamp: Date.now(),
        username,
        sendStatus: 'delivered',
      });
    }
    if (additions.length > 0) {
      useChatStore.getState().setMessages([...useChatStore.getState().messages, ...additions]);
    }
  }, [currentSessionId, isStreaming, pendingInjections.length]);

  const slashCommands = useChatStore((s) => s.slashCommands);
  const attachments = useChatStore((s) => s.attachments);
  const latestAssistantText = useMemo(() => {
    const assistant = [...messages].reverse().find((message) => message.role === 'assistant');
    return assistant?.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text || '')
      .join('\n')
      .trim() || '';
  }, [messages]);

  useEffect(() => {
    if (!AI_COMPOSER_AUTOCOMPLETE_ENABLED) {
      setComposerSettings(DEFAULT_AI_COMPOSER_SETTINGS);
      return;
    }
    let active = true;
    const load = async () => {
      try {
        const token = localStorage.getItem('token');
        const response = await fetch('/api/ai/composer-settings', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (active && response.ok) {
          const data = await response.json();
          if (typeof data?.enabled === 'boolean') {
            setComposerSettings({ ...DEFAULT_AI_COMPOSER_SETTINGS, ...data });
          }
        }
      } catch { /* keep last known settings */ }
    };
    void load();
    const interval = window.setInterval(load, 30_000);
    const refresh = () => { void load(); };
    window.addEventListener('tower:ai-composer-settings-changed', refresh);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('tower:ai-composer-settings-changed', refresh);
    };
  }, []);

  useEffect(() => {
    if (!AI_COMPOSER_AUTOCOMPLETE_ENABLED || !composerSettings.enabled || !currentSessionId || isStreaming || pendingQuestion || attachments.length > 0 || !latestAssistantText) {
      setGhostSuggestion('');
      setGhostSuffix('');
      return;
    }

    // Preserve the exact composer text, including a trailing space: inline
    // completion continues from the cursor, not from a normalized search query.
    const currentDraft = input;
    const isEmptyDraft = currentDraft.trim().length === 0;
    if ((isEmptyDraft && !composerSettings.emptyDraftEnabled)
      || (!isEmptyDraft && !composerSettings.inlineDraftEnabled)
      || (!isEmptyDraft && currentDraft.trim().length < composerSettings.minDraftLength)
      || (!isEmptyDraft && currentDraft.trim() === acceptedCompletionRef.current)
      || currentDraft === lastAutocompleteDraftRef.current) {
      setGhostSuggestion('');
      setGhostSuffix('');
      return;
    }
    const controller = new AbortController();
    const now = Date.now();
    const debounceReadyAt = now + composerSettings.debounceMs;
    const rateLimitReadyAt = lastAutocompleteRequestAtRef.current + composerSettings.minRequestIntervalMs;
    const delayMs = Math.max(0, Math.max(debounceReadyAt, rateLimitReadyAt) - now);
    const timer = window.setTimeout(async () => {
      const requestedAt = Date.now();
      lastAutocompleteRequestAtRef.current = requestedAt;
      lastAutocompleteDraftRef.current = currentDraft;
      try {
        const token = localStorage.getItem('token');
        const response = await fetch('/api/ai/reply-suggestion', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ assistantTail: latestAssistantText, draft: currentDraft }),
        });
        if (!response.ok) return;
        const payload = await response.json();
        if (controller.signal.aborted
          || draftValueRef.current !== currentDraft
          || Date.now() - requestedAt > composerSettings.responseMaxAgeMs) return;
        const suggestion = typeof payload?.suggestion === 'string' ? payload.suggestion : '';
        const suffix = typeof payload?.suffix === 'string' ? payload.suffix : '';
        setGhostSuggestion(isEmptyDraft ? suggestion : '');
        setGhostSuffix(isEmptyDraft ? '' : suffix);
      } catch (error) {
        if ((error as Error)?.name !== 'AbortError') console.debug('[chat] reply suggestion unavailable');
      }
    }, delayMs);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [attachments.length, composerSettings, currentSessionId, input, isStreaming, latestAssistantText, pendingQuestion]);

  const acceptGhostSuggestion = () => {
    const completion = input ? `${input}${ghostSuffix}` : ghostSuggestion;
    if (!completion.trim()) return;
    setGhostSuggestion('');
    setGhostSuffix('');
    acceptedCompletionRef.current = completion.trim();
    setDraftInput(completion);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(completion.length, completion.length);
      applyTextareaHeight(textarea);
    });
  };

  const showQuickReplies = input.trim().length === 0
    && attachments.length === 0
    && visiblePendingInjections.length === 0
    && messages.some((m) => m.role === 'assistant');
  const sendQuickReply = (message: string) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    const last = lastSubmitRef.current;
    // Quick replies can legitimately reappear as soon as the previous turn ends.
    // Only suppress the same physical double-click, not a later visible action.
    if (last && last.text === trimmed && Date.now() - last.at < 2_000) return;
    lastSubmitRef.current = { text: trimmed, at: Date.now() };

    setInput('');
    saveDraft(currentSessionId, '');
    setShowCommands(false);

    const sid = useChatStore.getState().sessionId || '';
    const isCurrentSessionStreaming = sid
      ? useSessionStore.getState().streamingSessions.has(sid)
      : useChatStore.getState().isStreaming;

    if (isCurrentSessionStreaming) {
      const active = useSessionStore.getState().sessions.find(
        (session) => session.id === useSessionStore.getState().activeSessionId
      );
      const activeIsPi = active?.engine === 'pi' || !!active?.modelUsed?.includes('/');
      if (activeIsPi) {
        lastSentRef.current = trimmed;
        onSend(trimmed);
      } else if (sid) {
        useChatStore.getState().markLatestUserQueued(trimmed);
        useChatStore.getState().enqueueMessage(sid, trimmed);
        const ws = (window as any).__towerWs as WebSocket | undefined;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'check_session_status', sessionId: sid }));
        }
      }
    } else {
      lastSentRef.current = trimmed;
      onSend(trimmed);
    }
  };

  // Pre-load slash commands from /api/commands so they're available before first message.
  // Fetch on session changes even if a previous session already populated commands:
  // the server registry is authoritative and project manifests must not inherit
  // stale slash items from another project.
  useEffect(() => {
    const tk = localStorage.getItem('token');
    const hdrs: Record<string, string> = {};
    if (tk) hdrs['Authorization'] = `Bearer ${tk}`;
    const session = useSessionStore.getState().sessions.find(
      s => s.id === currentSessionId
    );
    const params = new URLSearchParams();
    if (session?.projectId) params.set('projectId', session.projectId);
    if (session?.cwd) params.set('cwd', session.cwd);
    fetch(`/api/commands${params.toString() ? `?${params.toString()}` : ''}`, { headers: hdrs })
      .then((r) => r.ok ? r.json() : [])
      .then((cmds: Array<{
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
      }>) => {
        useChatStore.getState().setSystemInfo({
          slashCommands: cmds.map((c) => ({
            name: c.name.replace(/^\//, ''),
            canonical: c.canonical?.replace(/^\//, ''),
            aliases: c.aliases?.map((a) => a.replace(/^\//, '')),
            displayName: c.displayName,
            summary: c.summary,
            argumentHint: c.argumentHint,
            description: c.description,
            source: c.source as 'commands' | 'sdk' | 'skills' | 'native' | 'workflow',
            scope: c.scope as 'company' | 'project' | 'personal' | 'system' | undefined,
            kind: c.kind as 'native' | 'skill' | 'workflow' | undefined,
            risk: c.risk as 'low' | 'medium' | 'high' | 'destructive' | 'external-send' | 'deploy' | undefined,
          })),
        });
      })
      .catch(() => {
        useChatStore.getState().setSystemInfo({ slashCommands: [] });
      });
  }, [currentSessionId]);

  // textarea 높이를 적용하는 헬퍼.
  // manual 모드면 그 값을 고정. auto 면 scrollHeight 와 max 의 min.
  // 모바일/IME에서는 max height 이후 내부 scrollTop 이 stale 해져 "내용은 있는데
  // 입력창이 비어 보이는" 상태가 생길 수 있어 overflow 여부도 여기서 함께 고정한다.
  const applyTextareaHeight = (el: HTMLTextAreaElement) => {
    const maxH = manualHeight ?? defaultMaxH;
    if (manualHeight !== null) {
      el.style.height = `${manualHeight}px`;
    } else {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
    }
    el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden';
  };

  const keepTextareaCaretVisible = (el: HTMLTextAreaElement) => {
    // Only force-scroll the focused composer. Restoring drafts in background tabs
    // should not unexpectedly jump internal scroll position.
    if (document.activeElement !== el) return;
    const caretNearEnd = el.selectionStart >= el.value.length - 1 && el.selectionEnd >= el.value.length - 1;
    if (caretNearEnd) el.scrollTop = el.scrollHeight;
  };

  // Save/restore per-session draft when session changes.
  // Keep an explicit draft owner ref instead of trusting React's `input` value
  // during a session switch. React may commit `setInput(restoredDraft)` from the
  // previous switch after the user has already moved to the next session; saving
  // that stale state under the new session id is the exact draft-leak shape users
  // notice most often with cloned/rapidly switched sessions.
  const prevSessionRef = useRef<string | null>(null);
  const draftSessionRef = useRef<string | null>(null);
  const draftValueRef = useRef('');
  const setDraftInput = (value: string, sessionId: string | null = currentSessionId, persist = true) => {
    draftSessionRef.current = sessionId;
    draftValueRef.current = value;
    setInput(value);
    if (persist) saveDraft(sessionId, value);
  };
  useEffect(() => {
    if (prevSessionRef.current !== currentSessionId) {
      const prevSessionId = prevSessionRef.current;
      // Save only if the draft ref still belongs to that previous session. If a
      // pending React state update from another session is currently visible, do
      // not write it into the previous/new session's localStorage bucket.
      if (prevSessionId !== null && draftSessionRef.current === prevSessionId) {
        saveDraft(prevSessionId, draftValueRef.current);
      }
      // Load draft for new session
      const restored = loadDraft(currentSessionId);
      setDraftInput(restored, currentSessionId, false);
      setQueueExpanded(false);
      prevSessionRef.current = currentSessionId;
      // Restore textarea height. When revisiting a session with an unfinished
      // draft, continuing the edit takes precedence over restoring a historical
      // reading anchor: ask ChatPanel to reveal the composer at the latest turn.
      if (textareaRef.current) {
        const el = textareaRef.current;
        requestAnimationFrame(() => {
          applyTextareaHeight(el);
          if (prevSessionId !== null && restored.trim()) {
            window.dispatchEvent(new CustomEvent('tower-composer-draft-restored', {
              detail: { sessionId: currentSessionId },
            }));
          }
        });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId]);

  // manual height / defaultMaxH 가 바뀌면 즉시 textarea 재계산
  useEffect(() => {
    if (textareaRef.current) {
      applyTextareaHeight(textareaRef.current);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualHeight, defaultMaxH]);

  const commandQuery = input.startsWith('/') ? input.slice(1).trim().toLocaleLowerCase() : '';
  const filteredCommands = filterSlashCommands(slashCommands, input);
  const hasExactCommandMatch = hasExactSlashCommandMatch(input, filteredCommands);
  // Keep the picker open while the user has typed an exact command name but has
  // not yet committed it with a whitespace boundary. Otherwise `/agent` closes
  // the picker at the most useful moment, making Tab/Enter completion feel broken.
  const hasCommandArgumentBoundary = input.startsWith('/') && /^\/\S+\s/.test(input);

  useEffect(() => {
    const shouldShow = input.startsWith('/')
      && input.length > 0
      && !input.includes('\n')
      && filteredCommands.length > 0
      && !(hasExactCommandMatch && hasCommandArgumentBoundary);
    setShowCommands(shouldShow);
    if (!shouldShow) setSelectedIndex(0);
  }, [input, filteredCommands.length, hasExactCommandMatch, hasCommandArgumentBoundary]);

  // Reset selectedIndex when the query/result identity changes. Resetting only
  // on length leaves a stale highlighted row when `/agen` → `/agent` keeps the
  // same result count but reorders matches; Enter would then select the wrong row.
  const filteredCommandKey = commandIdentityKey(filteredCommands);
  useEffect(() => {
    setSelectedIndex(0);
  }, [commandQuery, filteredCommandKey]);

  // Track the last sent message for SESSION_BUSY re-queuing
  const lastSentRef = useRef<string | null>(null);

  // Re-entry guard for handleSubmit. setInput('') is async (React state),
  // so on a fast double-Enter the textarea still holds the old value when
  // the second handler fires — without this guard, two identical messages
  // would be sent (especially during the awaited finalize-uploads call).
  const isSubmittingRef = useRef(false);
  // Enter key auto-repeat can fire every ~200ms while a provider error returns
  // immediately. Ignore repeat keydown events so one held Enter cannot inject
  // the same prompt in a tight loop. (Incident: Kimi context-overflow 2026-05-18.)
  const lastSubmitRef = useRef<{ text: string; at: number } | null>(null);

  // Cascade guard: prevents queue.length change from re-triggering dequeue
  // before the server confirms streaming for this session.
  const drainGuardRef = useRef(false);
  const guardSessionRef = useRef<string | null>(null);

  // Auto-send first queued message when the current session becomes idle.
  // Uses the same per-session streaming source as the sidebar/toolchips.
  useEffect(() => {
    // Reset guard on session switch
    if (currentSessionId !== guardSessionRef.current) {
      drainGuardRef.current = false;
      guardSessionRef.current = currentSessionId;
    }

    if (!isStreaming && currentQueue.length > 0 && currentSessionId) {
      if (drainGuardRef.current) return;  // Already sent one, wait for the next streaming cycle
      const msg = useChatStore.getState().dequeueMessage(currentSessionId);
      if (msg) {
        useChatStore.getState().promoteLatestQueuedUser(msg);
        drainGuardRef.current = true;
        lastSentRef.current = msg;
        onSend(msg);
      }
    } else {
      // Reset guard when streaming is confirmed or queue becomes empty
      drainGuardRef.current = false;
    }
  }, [isStreaming, currentQueue.length, currentSessionId, onSend]);

  // Listen for SESSION_BUSY events — re-queue the last sent message
  useEffect(() => {
    const handler = () => {
      if (lastSentRef.current) {
        const sid = useChatStore.getState().sessionId || '';
        useChatStore.getState().markLatestUserQueued(lastSentRef.current);
        useChatStore.getState().enqueueMessage(sid, lastSentRef.current);
        lastSentRef.current = null;
      }
    };
    window.addEventListener('session-busy-requeue', handler);
    return () => window.removeEventListener('session-busy-requeue', handler);
  }, []);

  // Listen for restore/copy requests — put text back into input or clipboard.
  // Queue items are actually cancelled before dispatching this event. Pi mid-turn
  // steer chips are different: by the time the frontend sees them, the text has
  // already been handed to Pi SDK, so this is a recovery/copy action only.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<RestoreInputTextDetail>).detail;
      const text = typeof detail === 'string' ? detail : detail?.text;
      const source = typeof detail === 'string' ? 'queue-cancel' : detail?.source;
      if (!text) return;

      const currentInput = textareaRef.current?.value?.trim() || '';
      if (!currentInput) {
        // Input is empty — restore directly
        setDraftInput(text);
        if (textareaRef.current) {
          const el = textareaRef.current;
          requestAnimationFrame(() => {
            applyTextareaHeight(el);
            el.focus();
          });
        }
        toastInfo(
          source === 'steer-cancel'
            ? t('steeringRestored')
            : source === 'steer-copy'
              ? t('pendingMessageRestored')
              : t('queueRestored')
        );
      } else if (source === 'steer-cancel') {
        // A cancelled steer should return to the composer even when the user has
        // already resumed typing. Append on the next line without blank spacing.
        const restored = `${currentInput}\n${text}`.trim();
        setDraftInput(restored);
        if (textareaRef.current) {
          const el = textareaRef.current;
          requestAnimationFrame(() => {
            applyTextareaHeight(el);
            el.focus();
          });
        }
        toastInfo(t('steeringRestored'));
      } else {
        // Input has text — copy to clipboard instead
        navigator.clipboard.writeText(text).then(() => {
          toastInfo(
            source === 'steer-copy'
              ? t('pendingMessageCopied')
              : t('queueCopied')
          );
        }).catch(() => {
          toastInfo(
            source === 'steer-copy'
              ? t('pendingCopyFailed')
              : t('queueCanceled')
          );
        });
      }
    };
    window.addEventListener('restore-input-text', handler);
    return () => window.removeEventListener('restore-input-text', handler);
  }, [currentSessionId]);

  const requestServerSessionStatusCheck = (sid: string, reason: string) => {
    const ws = (window as any).__towerWs as WebSocket | undefined;
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log(`[chat] stale guard: requesting server status check for session ${sid.slice(0, 8)} (${reason})`);
      ws.send(JSON.stringify({ type: 'check_session_status', sessionId: sid }));
    }
  };

  // Stale work guard: ask the server whether a session is *actually* running.
  // This is intentionally non-destructive: it never aborts a long Pi turn; it
  // only clears frontend UI if the backend replies `idle`.
  //
  // Covers three bug shapes:
  //   1. queue:    non-PI session, message enqueued waiting for engine_done
  //   2. injection: PI session, "전달 대기 중" chip waiting for steer_delivered
  //   3. pure UI: sidebar/input says "running" but there is no queued work/chip
  //
  // (3) happens after restart/reconnect races where the idle frame or active-session
  // ack is missed. Older monitoring only covered (1)/(2), so the UI could stay
  // busy forever even though the server had no active run.
  const hasPending = pendingInjections.length > 0;
  const staleGuardTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (staleGuardTimerRef.current) {
      clearTimeout(staleGuardTimerRef.current);
      staleGuardTimerRef.current = undefined;
    }

    if ((hasQueue || hasPending) && isStreaming && currentSessionId) {
      staleGuardTimerRef.current = setTimeout(() => {
        // Re-check conditions (state may have changed during the 10s wait)
        const sid = useChatStore.getState().sessionId;
        const queue = sid ? useChatStore.getState().messageQueue[sid] : [];
        const pending = sid ? useChatStore.getState().pendingInjections[sid] : [];
        const stillStreaming = sid ? useSessionStore.getState().streamingSessions.has(sid) : false;
        const stillHasWork = (queue && queue.length > 0) || (pending && pending.length > 0);
        if (stillHasWork && stillStreaming && sid) {
          requestServerSessionStatusCheck(sid, `queue=${queue?.length ?? 0}, pending=${pending?.length ?? 0}`);
        }
      }, 10_000); // 10 seconds — fast recovery from stale queued work
    }

    return () => {
      if (staleGuardTimerRef.current) {
        clearTimeout(staleGuardTimerRef.current);
        staleGuardTimerRef.current = undefined;
      }
    };
  }, [hasQueue, hasPending, isStreaming, currentSessionId]);

  const activeStreamingProbeRef = useRef<ReturnType<typeof setInterval>>(undefined);
  useEffect(() => {
    if (activeStreamingProbeRef.current) {
      clearInterval(activeStreamingProbeRef.current);
      activeStreamingProbeRef.current = undefined;
    }

    if (isStreaming && currentSessionId) {
      activeStreamingProbeRef.current = setInterval(() => {
        const sid = useChatStore.getState().sessionId;
        if (!sid) return;
        const stillStreaming = useSessionStore.getState().streamingSessions.has(sid);
        if (stillStreaming) requestServerSessionStatusCheck(sid, 'active-stream-liveness');
      }, 30_000);
    }

    return () => {
      if (activeStreamingProbeRef.current) {
        clearInterval(activeStreamingProbeRef.current);
        activeStreamingProbeRef.current = undefined;
      }
    };
  }, [isStreaming, currentSessionId]);

  const buildMessageFrom = (text: string, atts: typeof attachments): string => {
    if (atts.length === 0) return text;

    const parts: string[] = [];
    for (const att of atts) {
      if (att.type === 'prompt') {
        parts.push(att.content);
      } else if (att.type === 'command') {
        parts.push(att.content);
      } else if (att.type === 'file') {
        parts.push(`[file: ${att.content}]`);
      } else if (att.type === 'upload') {
        // Legacy/error upload cards can contain arbitrary text. Never inline it
        // into the provider prompt; actual files use path-only `file` cards.
        parts.push(`[upload notice: ${att.label}]`);
      }
    }

    // Command type: prepend as slash command prefix
    const hasCommand = atts.some((a) => a.type === 'command');
    if (hasCommand) {
      const cmdParts = atts.filter((a) => a.type === 'command').map((a) => a.content);
      const otherParts = atts.filter((a) => a.type !== 'command');
      const prefix = cmdParts.join(' ');
      const otherContent = otherParts.map((a) => a.type === 'file' ? `[file: ${a.content}]` : a.content).join('\n\n');
      const combined = otherContent ? `${otherContent}\n\n${text}` : text;
      return `${prefix} ${combined}`.trim();
    }

    // Prompt/file: join with double newlines before user text
    return `${parts.join('\n\n')}\n\n${text}`.trim();
  };

  const handleSubmit = async (immediateInput?: string) => {
    // Reject re-entry while the previous submit is still awaiting finalize-uploads
    if (isSubmittingRef.current) return;
    // Paste/input events can be followed by Enter before React commits the new
    // controlled value. The textarea's live DOM value is authoritative for a
    // keyboard submit, preventing the first Enter from seeing stale/empty state.
    const trimmed = (typeof immediateInput === 'string' ? immediateInput : input).trim();
    const hasContent = trimmed || attachments.length > 0;
    if (!hasContent) return;

    const dedupeText = buildMessageFrom(trimmed, attachments).trim();
    const last = lastSubmitRef.current;
    if (last && last.text === dedupeText && Date.now() - last.at < 10_000) {
      return;
    }
    lastSubmitRef.current = { text: dedupeText, at: Date.now() };

    isSubmittingRef.current = true;
    try {
      if (pendingQuestion && attachments.length === 0 && onAnswerQuestion) {
        setDraftInput('');
        setShowCommands(false);
        onAnswerQuestion(pendingQuestion.questionId, trimmed);
        return;
      }

      // Clear UI immediately to prevent double-submit
      const currentAttachments = [...attachments];
      const submittedFromHeight = textareaRef.current?.offsetHeight ?? null;
      setDraftInput('');
      setShowCommands(false);
      useChatStore.getState().clearAttachments();
      if (textareaRef.current) {
        textareaRef.current.style.height = submittedFromHeight && isSafeStopAvailable
          ? `${submittedFromHeight}px`
          : 'auto';
      }

      // Session attachments remain temporary after send. Saving to Personal Space
      // or the project requires an explicit promotion request.

      // Build message with stable session:// attachment URIs
      const message = buildMessageFrom(trimmed, currentAttachments);
      const sendOptions: SendOptions | undefined = message.trimStart().startsWith('/') && selectedCommandTriggerRef.current
        ? { commandTrigger: selectedCommandTriggerRef.current }
        : undefined;
      selectedCommandTriggerRef.current = null;

      // Read from the authoritative per-session streaming store synchronously.
      // This avoids double-sends on fast Enter presses and keeps queue behavior
      // aligned with the sidebar/tool chips.
      const sid = useChatStore.getState().sessionId || '';
      const isCurrentSessionStreaming = sid
        ? useSessionStore.getState().streamingSessions.has(sid)
        : useChatStore.getState().isStreaming;

      if (isCurrentSessionStreaming) {
        const active = useSessionStore.getState().sessions.find(
          (session) => session.id === useSessionStore.getState().activeSessionId
        );
        const activeIsPi = active?.engine === 'pi' || !!active?.modelUsed?.includes('/');
        if (activeIsPi) {
          // Pi supports mid-turn steering. Send immediately; backend will call
          // AgentSession.steer() instead of waiting for engine_done.
          lastSentRef.current = message;
          sendOptions ? onSend(message, sendOptions) : onSend(message);
        } else {
          useChatStore.getState().markLatestUserQueued(message);
          useChatStore.getState().enqueueMessage(sid, message);
          // Immediately ask server to confirm streaming state — if it's stale,
          // server will send session_status:idle and the queue will auto-drain.
          // This is much faster than the 2-minute stale guard.
          const ws = (window as any).__towerWs as WebSocket | undefined;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'check_session_status', sessionId: sid }));
          }
        }
      } else {
        lastSentRef.current = message;   // track for SESSION_BUSY re-queuing
        sendOptions ? onSend(message, sendOptions) : onSend(message);
      }
    } finally {
      isSubmittingRef.current = false;
    }
  };

  const handleCancelQueue = () => {
    if (currentSessionId) {
      useChatStore.getState().clearQueuedUsersForSession(currentSessionId);
      useChatStore.getState().clearSessionQueue(currentSessionId);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showCommands) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const exact = filteredCommands.find((cmd) => commandNameFields(cmd).some((name) => name === commandQuery));
        const target = exact || filteredCommands[Math.min(selectedIndex, filteredCommands.length - 1)];
        if (target) {
          selectCommand(target.canonical || target.name);
        }
        return;
      }
    }
    if (e.key === 'Tab' && !e.nativeEvent.isComposing && (ghostSuggestion || ghostSuffix)) {
      e.preventDefault();
      acceptGhostSuggestion();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // Browser key repeat should not become repeated chat submissions.
      if (e.repeat) return;
      handleSubmit(e.currentTarget.value);
    }
    if (e.key === 'Escape') {
      const pq = useChatStore.getState().pendingQuestion;
      if (pq) {
        // AUQ is a real engine pause, not a dismissible toast. Keep the card
        // visible until the user answers, skips, times out, or the backend clears it.
        e.preventDefault();
        return;
      } else if (isStreaming) {
        // Esc during streaming = Stop (preserve draft + restore queue)
        e.preventDefault();
        const sid = useChatStore.getState().sessionId;
        if (sid) {
          const queue = useChatStore.getState().messageQueue[sid];
          if (queue && queue.length > 0) {
            const restored = [input, ...queue].filter(Boolean).join('\n\n');
            setDraftInput(restored, sid);
            useChatStore.getState().clearSessionQueue(sid);
          }
        }
        onAbort();
      } else if (hasQueue) {
        handleCancelQueue();
      } else if (showCommands) {
        setShowCommands(false);
      }
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    acceptedCompletionRef.current = '';
    setGhostSuggestion('');
    setGhostSuffix('');
    setDraftInput(val);
    if (val.trim() !== lastSubmitRef.current?.text) {
      lastSubmitRef.current = null;
    }
    // Batch height recalculation into a single rAF to avoid layout thrashing
    // that causes visible jitter on mobile when the virtual keyboard is open.
    const el = e.target;
    requestAnimationFrame(() => {
      applyTextareaHeight(el);
      keepTextareaCaretVisible(el);
    });
  };

  const selectCommand = (cmd: string) => {
    const normalized = cmd.replace(/^\//, '');
    // Slash selection should only complete the visible command text. The skill
    // body must stay in the engine/runtime skill layer, not become a chat-input
    // attachment or user-message prefix.
    const nextInput = input.replace(/^\/[^\s]*\s?/, `/${normalized} `);
    selectedCommandTriggerRef.current = 'picker';
    setDraftInput(nextInput);
    setShowCommands(false);
    textareaRef.current?.focus();
  };

  // Manual height — 드래그로 사용자가 명시 지정. localStorage 영속.
  const handleManualResize = (h: number) => {
    setManualHeight(h);
    saveManualHeight(h);
  };
  // 더블클릭 → auto 복귀.
  const handleResetHeight = () => {
    setManualHeight(null);
    saveManualHeight(null);
    if (textareaRef.current) {
      // 즉시 재계산 (useEffect 으로도 잡히지만 사용자 체감 즉시성 위해 직접 호출)
      const el = textareaRef.current;
      requestAnimationFrame(() => {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, defaultMaxH) + 'px';
      });
    }
  };

  // ───── Drag & Drop ─────
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (dragCounter.current === 1) setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragOver(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragOver(false);

    // File Exchange refs are opaque and become a fresh session-scoped snapshot.
    const exchangeRaw = e.dataTransfer.getData('application/x-tower-file-exchange');
    if (exchangeRaw) {
      try {
        const { decodeExchangeDrag, transferFile } = await import('../../features/file-exchange/fileExchange');
        const payload = decodeExchangeDrag(exchangeRaw);
        const sessionId = useSessionStore.getState().activeSessionId;
        if (!payload || !sessionId) {
          toastInfo(t('selectSessionBeforeAttach'));
          return;
        }
        const receipt = await transferFile(payload.source, { scope: 'session', sessionId }, async () => true);
        const result = receipt?.result as { attachmentId?: string; uri?: string; name?: string } | null;
        if (receipt?.status === 'completed' && result?.attachmentId && result.uri) {
          useChatStore.getState().addAttachment({
            id: `upload-${result.attachmentId}`,
            type: 'file',
            label: result.name || payload.name,
            content: result.uri,
            size: payload.sizeBytes,
            mimeType: payload.mimeType || undefined,
            sessionAttachmentId: result.attachmentId,
          });
          textareaRef.current?.focus();
        } else {
          toastInfo(receipt?.status === 'stale' ? t('sourceChangedDrag') : t('attachPermissionDenied'));
        }
      } catch (error) {
        toastInfo(error instanceof Error ? error.message : t('attachFailed'));
      }
      return;
    }

    // Handle internal drag (prompt/command/file tree attachments)
    const raw = e.dataTransfer.getData('application/x-attachment');
    if (raw) {
      try {
        const data = JSON.parse(raw);
        if (data.type && data.label && data.content) {
          useChatStore.getState().addAttachment({
            id: `${data.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: data.type,
            label: data.label,
            content: data.content,
          });
          textareaRef.current?.focus();
        }
      } catch {}
      return;
    }

    // Handle OS file drops — always upload to server and pass a [file: path]
    // reference to the AI. We intentionally do NOT inline small text/CSV/code
    // files into the chat message: uploaded files are workspace artifacts, and
    // the model should read them through file tools only when needed.
    // See workspace/decisions/2026-06-12-chat-uploads-path-only.md
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;
    await uploadFilesToServer(files);
    textareaRef.current?.focus();
  };

  // File picker handler — invoked when user clicks the attach button.
  // We reset input.value at the end so selecting the same file twice in a row
  // still triggers onChange (browsers de-dup identical selections otherwise).
  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    await uploadFilesToServer(Array.from(files));
    e.target.value = '';
  };

  // ───── Shared upload helper ─────
  const uploadFilesToServer = async (files: File[]) => {
    // Client-side optimization pass before hitting the network. For a large
    // PDF batch, preserve one file per user-selected document: splitting every
    // PDF multiplies attachment references and makes eager model inspection more
    // likely to exhaust context. Single/small batches keep the legacy optimizer.
    const pdfCount = files.filter(file => file.type === 'application/pdf' || /\.pdf$/i.test(file.name)).length;
    const shouldPreservePdfBatch = pdfCount >= 10;
    const optimized = shouldPreservePdfBatch
      ? {
          files,
          originalBytes: files.reduce((sum, file) => sum + file.size, 0),
          optimizedBytes: files.reduce((sum, file) => sum + file.size, 0),
          changedCount: 0,
          notes: [] as string[],
        }
      : await optimizeBatch(files);
    if (optimized.changedCount > 0 && optimized.optimizedBytes < optimized.originalBytes) {
      const saved = Math.round((1 - optimized.optimizedBytes / optimized.originalBytes) * 100);
      toastInfo(
        t('filesOptimized', { count: optimized.changedCount, original: formatBytes(optimized.originalBytes), optimized: formatBytes(optimized.optimizedBytes), saved })
      );
    }
    const activeSessionId = useSessionStore.getState().activeSessionId;
    if (!activeSessionId) {
      toastInfo(t('selectSessionBeforeAttach'));
      return;
    }
    try {
      const token = localStorage.getItem('token');
      const uploadedAttachments: Array<{
        id: string;
        name: string;
        uri: string;
        promotedUri?: string | null;
        sizeBytes?: number;
        mimeType?: string | null;
        expiresAt?: string;
        status?: 'session_attachment' | 'project_file';
      }> = [];
      const uploadFailures: Array<{ name?: string; error?: string }> = [];
      const batches: File[][] = [];
      let currentBatch: File[] = [];
      let currentBatchBytes = 0;
      const maxBatchBytes = 200 * 1024 * 1024;
      for (const file of optimized.files) {
        if (currentBatch.length > 0 && (currentBatch.length >= 20 || currentBatchBytes + file.size > maxBatchBytes)) {
          batches.push(currentBatch);
          currentBatch = [];
          currentBatchBytes = 0;
        }
        currentBatch.push(file);
        currentBatchBytes += file.size;
      }
      if (currentBatch.length > 0) batches.push(currentBatch);

      // Bound multipart requests by both file count and aggregate bytes.
      const totalBytes = optimized.files.reduce((sum, file) => sum + file.size, 0);
      let completedBytes = 0;
      let completedFiles = 0;
      setUploadProgress({
        phase: 'uploading',
        loadedBytes: 0,
        totalBytes,
        percent: 0,
        completedFiles: 0,
        totalFiles: optimized.files.length,
        currentFileName: optimized.files[0]?.name || t('fileFallback'),
      });
      for (const filesInBatch of batches) {
        const batchBytes = filesInBatch.reduce((sum, file) => sum + file.size, 0);
        const data = await uploadFileBatchWithProgress({
          url: `/api/session-attachments/${encodeURIComponent(activeSessionId)}`,
          token,
          files: filesInBatch,
          completedBytes,
          totalBytes,
          completedFiles,
          totalFiles: optimized.files.length,
          onProgress: setUploadProgress,
        });
        uploadedAttachments.push(...(data.attachments || []));
        uploadFailures.push(...(data.failures || []));
        completedBytes += batchBytes;
        completedFiles += filesInBatch.length;
      }
      for (const attachment of uploadedAttachments) {
        useChatStore.getState().addAttachment({
          id: `upload-${attachment.id}`,
          type: 'file',
          label: attachment.name,
          content: attachment.promotedUri || attachment.uri,
          size: attachment.sizeBytes,
          mimeType: attachment.mimeType || undefined,
          sessionAttachmentId: attachment.status === 'project_file' ? undefined : attachment.id,
          expiresAt: attachment.expiresAt || undefined,
        });
      }
      if (uploadFailures.length > 0) {
        const names = uploadFailures.slice(0, 3).map(failure => failure.name || t('fileFallback')).join(', ');
        const rest = uploadFailures.length > 3 ? t('additionalFiles', { count: uploadFailures.length - 3 }) : '';
        useChatStore.getState().addAttachment({
          id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          type: 'upload',
          label: t('partialUploadFailed'),
          content: `[Upload failed: ${names}${rest}]`,
        });
      }
    } catch (error) {
      useChatStore.getState().addAttachment({
        id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: 'upload',
        label: 'Upload failed',
        content: `[Upload failed: ${error instanceof Error ? error.message : 'network error'}]`,
      });
    } finally {
      setUploadProgress(null);
    }
  };

  // ───── Clipboard Paste (images/files/text) ─────
  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;

    const files: File[] = [];
    if (items) {
      for (const item of Array.from(items)) {
        // Only intercept file/image pastes as uploads. Plain text is handled below
        // so React's controlled draft is current before the user immediately hits
        // Enter or the send button.
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
    }

    if (files.length > 0) {
      e.preventDefault(); // prevent pasting blob URL as text
      await uploadFilesToServer(files);
      textareaRef.current?.focus();
      return;
    }

    const pastedText = e.clipboardData?.getData('text/plain') ?? '';
    if (!pastedText) return;

    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const nextValue = `${el.value.slice(0, start)}${pastedText}${el.value.slice(end)}`;
    const nextCaret = start + pastedText.length;

    setDraftInput(nextValue);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.selectionStart = nextCaret;
      textarea.selectionEnd = nextCaret;
      applyTextareaHeight(textarea);
      keepTextareaCaretVisible(textarea);
    });
  };

  return (
    <div className="w-full relative">
      {/* Turn/runtime status */}
      {turnStatusText(activeTurn.phase, hasQueue, t) && (
        <div className="relative z-[2] mb-2">
          <div className="flex items-center gap-2 px-4 py-2 bg-surface-900/60 border border-surface-700/50 rounded-xl text-[15px] text-gray-300 backdrop-blur-sm">
            {activeTurn.phase === 'error' ? (
              <div className="w-2 h-2 rounded-full shrink-0 bg-red-400" />
            ) : (
              <RunIndicator size="xs" label="" className="shrink-0 text-primary-400" />
            )}
            <span className="truncate flex-1">{turnStatusText(activeTurn.phase, hasQueue, t)}</span>
            {hasQueue && (
              <button
                type="button"
                onClick={() => setQueueExpanded((v) => !v)}
                className="flex items-center gap-1 text-[13px] px-2 py-0.5 rounded-full bg-primary-500/10 border border-primary-500/20 text-primary-300 hover:bg-primary-500/20 hover:text-primary-200 transition-colors shrink-0"
                title={queueExpanded ? t('queueClose') : t('queueOpen')}
                aria-expanded={queueExpanded}
              >
                <span>+{currentQueue.length}</span>
                <svg
                  className={`w-3 h-3 transition-transform ${queueExpanded ? 'rotate-180' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            )}
          </div>
          {hasQueue && queueExpanded && (
            <div className="mt-1.5 rounded-xl border border-surface-700/50 bg-surface-900/40 backdrop-blur-sm overflow-hidden">
              <ul className="divide-y divide-surface-700/40 max-h-60 overflow-y-auto">
                {currentQueue.map((text, idx) => (
                  <li
                    key={`${idx}-${text.slice(0, 16)}`}
                    className="flex items-start gap-2 px-3 py-2 group hover:bg-surface-800/40 transition-colors"
                  >
                    <span className="shrink-0 text-[12px] font-semibold text-primary-300/70 mt-0.5 tabular-nums">
                      {idx + 1}
                    </span>
                    <span
                      className="flex-1 text-[14px] text-gray-300 whitespace-pre-wrap line-clamp-2 break-words"
                      title={text}
                    >
                      {text}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (!currentSessionId) return;
                        const popped = useChatStore
                          .getState()
                          .cancelQueuedMessageAtIndex(currentSessionId, idx);
                        if (popped) {
                          window.dispatchEvent(
                            new CustomEvent('restore-input-text', { detail: popped }),
                          );
                        }
                      }}
                      className="shrink-0 p-1 rounded hover:bg-primary-500/20 text-primary-300 hover:text-primary-200 transition-colors opacity-70 group-hover:opacity-100"
                      title={t('restoreToInput')}
                      aria-label={t('restoreToInput')}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!currentSessionId) return;
                        useChatStore.getState().cancelQueuedMessageAtIndex(currentSessionId, idx);
                      }}
                      className="shrink-0 p-1 rounded hover:bg-red-500/20 text-gray-400 hover:text-red-300 transition-colors opacity-70 group-hover:opacity-100"
                      title={t('removeFromQueue')}
                      aria-label={t('removeFromQueue')}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Mid-turn injections awaiting agent pickup — rendered as a back layer
          behind the composer so it feels like a second input sheet, not a
          floating bubble competing with status text. */}
      <div
        className="relative transition-[padding-top] duration-200"
        style={{ paddingTop: steeringLayerReservedHeight }}
      >
        {visiblePendingInjections.length > 0 && (
          <div
            style={{ minHeight: steeringLayerHeight }}
            className="tower-steering-sheet pointer-events-none absolute left-0 right-0 top-0 z-0 rounded-t-2xl rounded-b-md backdrop-blur-xl animate-in fade-in slide-in-from-bottom-1 duration-200"
            aria-label={t('pendingSteering')}
          >
            <div className="pointer-events-auto flex items-start gap-3 px-3 pb-6 pt-3 sm:px-4 text-[14px]">
              <span className="tower-steering-spinner mt-1 w-2.5 h-2.5 border-[1.5px] rounded-full animate-spin shrink-0" />
              <button
                type="button"
                onClick={() => setSteerExpanded((v) => !v)}
                className={`tower-steering-text min-w-0 flex-1 text-left leading-relaxed ${
                  steerExpanded ? '' : 'max-h-16 overflow-hidden'
                }`}
                title={steerExpanded ? t('collapse') : pendingInjectionText}
                aria-expanded={steerExpanded}
              >
                {steerExpanded ? (
                  <span className="flex flex-col gap-0.5">
                    {visiblePendingInjections.map((it) => (
                      <span key={it.id} className="whitespace-pre-wrap break-words">
                        {it.text}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="flex flex-col gap-0.5">
                    {steeringPreview.lines.map((line, idx) => (
                      <span key={`${idx}-${line}`} className="truncate">
                        {line || ' '}
                      </span>
                    ))}
                    {steeringPreview.hiddenLineCount > 0 && (
                      <span className="mt-0.5 text-[13px] font-medium opacity-70">
                        {t('hiddenLines', { count: steeringPreview.hiddenLineCount })}
                      </span>
                    )}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  const ws = (window as any).__towerWs as WebSocket | undefined;
                  if (ws && ws.readyState === WebSocket.OPEN && currentSessionId) {
                    for (const it of visiblePendingInjections) {
                      ws.send(JSON.stringify({ type: 'cancel_steer', sessionId: currentSessionId, messageId: it.id }));
                    }
                  } else {
                    toastInfo(t('connectionCancelFailed'));
                  }
                }}
                className="tower-steering-cancel shrink-0 rounded-lg p-1 transition-colors"
                title={t('cancelSteeringRestore')}
                aria-label={t('cancelPendingMessage')}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.3} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}

        {showQuickReplies && (
          <div className={`relative z-10 flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${isMobile ? 'mb-1.5 px-1' : 'mb-2 px-2'}`}>
            <button
              type="button"
              onClick={() => sendQuickReply(t('continueRequest'))}
              className="shrink-0 rounded-full border border-surface-700/70 bg-surface-900/70 px-2.5 py-1 text-[13px] font-medium text-gray-300 hover:border-surface-600 hover:bg-surface-800/80 hover:text-gray-100 active:bg-surface-700/70"
            >
              {t('quickContinue')}
            </button>
            <button
              type="button"
              onClick={() => sendQuickReply(t('explainRequest'))}
              className="shrink-0 rounded-full border border-surface-700/70 bg-surface-900/70 px-2.5 py-1 text-[13px] font-medium text-gray-300 hover:border-surface-600 hover:bg-surface-800/80 hover:text-gray-100 active:bg-surface-700/70"
            >
              {t('quickExplain')}
            </button>
            <button
              type="button"
              onClick={() => sendQuickReply(t('saveDecisionRequest'))}
              className="shrink-0 rounded-full border border-surface-700/70 bg-surface-900/70 px-2.5 py-1 text-[13px] font-medium text-gray-300 hover:border-surface-600 hover:bg-surface-800/80 hover:text-gray-100 active:bg-surface-700/70"
            >
              {t('quickSaveDecision')}
            </button>
          </div>
        )}

        <div
        data-tour-id="chat-input"
        style={{ marginTop: visiblePendingInjections.length > 0 ? -steeringLayerOverlap : 0 }}
        className={`tower-input-shell relative z-10 rounded-2xl bg-surface-800 shadow-[0_10px_28px_rgba(0,0,0,0.16)] backdrop-blur-xl transition-[box-shadow,background-color,ring-color,margin-top] duration-200 ${
          isDragOver
            ? 'ring-1 ring-primary-500/45 bg-primary-900/10 shadow-[0_12px_32px_rgba(0,0,0,0.20)]'
            : 'ring-0 hover:bg-surface-800 focus-within:bg-surface-800 focus-within:shadow-[0_12px_32px_rgba(0,0,0,0.18)]'
        }`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Drop overlay */}
        {isDragOver && (
          <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-primary-900/20 backdrop-blur-sm z-10 pointer-events-none">
            <span className="text-[15px] text-primary-300 font-medium">Drop here</span>
          </div>
        )}

        {showCommands && (
          <CommandPicker
            commands={filteredCommands}
            selectedIndex={selectedIndex}
            onSelect={selectCommand}
            onHover={setSelectedIndex}
          />
        )}

        {/* Upload progress and attachment chips */}
        {(uploadProgress || attachments.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5 pb-0.5">
            {uploadProgress && <UploadProgressChip progress={uploadProgress} />}
            {attachments.map((att) => (
              <AttachmentChip
                key={att.id}
                attachment={att}
                onRemove={(id) => {
                  const att = useChatStore.getState().attachments.find(a => a.id === id);
                  // Temporary intake objects are deleted when removed before send.
                  // Direct Project uploads are durable Project files and have no sessionAttachmentId.
                  if (att?.type === 'file' && att.sessionAttachmentId) {
                    const sessionId = useSessionStore.getState().activeSessionId;
                    const token = localStorage.getItem('token');
                    const headers: Record<string, string> = {};
                    if (token) headers['Authorization'] = `Bearer ${token}`;
                    if (sessionId) fetch(`/api/session-attachments/${encodeURIComponent(sessionId)}/${att.sessionAttachmentId}`, {
                      method: 'DELETE', headers,
                    }).catch(() => {});
                  }
                  useChatStore.getState().removeAttachment(id);
                }}
              />
            ))}
          </div>
        )}

        {/* 데스크탑 드래그 리사이즈 핸들 — 입력 행 위에 hairline.
            모바일은 안 보임 (대신 fullscreen 버튼 사용). */}
        {!isMobile && (
          <InputResizeHandle
            currentHeight={textareaRef.current?.offsetHeight ?? effectiveMaxH}
            onResize={handleManualResize}
            onReset={handleResetHeight}
            isManual={manualHeight !== null}
          />
        )}

        <div className={`flex items-end relative ${isMobile ? 'gap-0.5 px-1.5 py-1' : 'gap-2 p-2'}`}>
          {/* Hidden file picker — opened by the attach button below.
              No `accept` filter so users can pick any file type; mobile picker
              still surfaces "Photo Library / Take Photo / Choose File" naturally
              from the OS chooser when the user wants an image. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileInputChange}
            className="hidden"
          />
          {/* Attach button — primary entry point for mobile photo/file uploads.
              Desktop users typically use drag&drop or paste, which don't work
              reliably on mobile browsers. Always-visible button so the path is
              discoverable on every device. Disabled during streaming to avoid
              attaching to an in-flight turn (matches Send button rule). */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isStreaming || uploadProgress !== null}
            // disabled 시 opacity-40 → 60 으로 완화. opacity-40 은 어두운 배경에서
            // 거의 사라진 듯 보여 "버튼이 없어졌다" 오해 유발. 60 은 어두워도 인지 가능.
            className={`rounded-xl transition-all shrink-0 disabled:opacity-60 disabled:cursor-not-allowed self-end ${
              isMobile
                // 모바일: ghost — 배경 없음, 호버/active 만 표시. textarea 가 시각적 주인공.
                ? 'p-1.5 m-0.5 text-gray-500 hover:text-surface-200 active:bg-surface-700/60'
                // 데스크탑: surrounding stroke icons 와 맞춘 작은 line icon. 이모지/고해상도 느낌 제거.
                : 'p-2 m-1 bg-transparent hover:bg-surface-700/45 text-gray-500 hover:text-surface-100'
            }`}
            title={isStreaming ? t('streamingAttachDisabled') : t('attachFile')}
            aria-label={t('attachFile')}
          >
            <svg className={isMobile ? 'w-4 h-4' : 'w-[18px] h-[18px]'} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.9} d="M9.25 12.75l5.5-5.5a2.5 2.5 0 013.54 3.54l-7.25 7.25a4 4 0 01-5.66-5.66l7.05-7.05" />
            </svg>
          </button>
          <div className="relative flex-1 min-w-0">
            {ghostSuffix && input && (
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-0 whitespace-pre-wrap break-words border-none py-3 text-input-size text-transparent min-h-[48px] overflow-hidden ${isMobile ? 'px-2' : 'px-4'}`}
              >
                <span>{input}</span><span className="text-surface-500 italic">{ghostSuffix}</span>
              </div>
            )}
            <textarea
              ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={(e) => {
              // iOS Chrome/Safari: 키보드 슬라이드업 애니메이션(~300ms) 도중
              // visualViewport.resize 가 띄엄띄엄 도착해 --vvh 가 stale 한 채로
              // InputBox 가 키보드 뒤로 잠시 숨음 (사용자 보고: "타자 치려 하면
              // 입력창 사라짐, 한 글자 쳐야 원위치"). main.tsx 의 focusin rAF
              // 폴링이 1차 안전망이고, 여기서 키보드 안착 후 scrollIntoView 로
              // 2차 안전망. 백업 보호라 모바일 외에서도 무해.
              const el = e.currentTarget;
              setTimeout(() => {
                if (typeof el.scrollIntoView === 'function') {
                  el.scrollIntoView({ block: 'end', behavior: 'smooth' });
                }
              }, 320);
            }}
            placeholder={
              // 모바일은 좁은 폭 + placeholder 가 작아도 길면 2줄 점유 → 짧은 문구로 분기.
              activeTurn.phase === 'awaiting_user'
                ? (isMobile ? t('answerShort') : t('answerPrompt'))
                : isStreaming
                  ? (isPiStreamingSession
                    ? (isMobile ? t('steerShort') : t('steerPrompt'))
                    : (isMobile ? t('nextTurnShort') : t('sendNextTurn')))
                  : attachments.length > 0
                    ? (isMobile ? t('addShort') : t('addOrSend'))
                    : ghostSuggestion || (isMobile ? t('messageShort') : t('typeMessage'))
            }
            rows={1}
            aria-label={t('messageInput')}
            style={{ maxHeight: `${effectiveMaxH}px`, WebkitOverflowScrolling: 'touch' }}
            className={`relative z-[1] w-full bg-transparent border-none py-3 text-input-size text-gray-100 placeholder:text-surface-500 placeholder:italic resize-none focus:outline-none focus:ring-0 min-h-[48px] overscroll-contain ${
              isMobile ? 'px-2' : 'px-4'
            }`}
          />
            {(ghostSuggestion || ghostSuffix) && (
              <div className={`pointer-events-none absolute bottom-0 right-1 z-[2] text-[10px] text-surface-500 ${isMobile ? 'hidden' : ''}`}>
                {t('autocompleteHint')}
              </div>
            )}
          </div>

          {(ghostSuggestion || ghostSuffix) && isMobile && (
            <button
              type="button"
              onClick={acceptGhostSuggestion}
              className="shrink-0 self-center rounded-full border border-primary-500/25 bg-primary-500/10 px-2.5 py-1 text-[11px] font-medium text-primary-200 active:bg-primary-500/20"
              aria-label={t('fillSuggestion')}
              title={t('fillSuggestion')}
            >
              {t('complete')}
            </button>
          )}

          {/* Mini nav: jump to previous / next user message ("질문").
              Placed BEFORE Stop/Send so its position stays consistent
              regardless of which action button is currently rendered.
              Each arrow only shows when that direction has a target.
              모바일에서도 노출 — 사용자 우선순위 (질문 nav > textarea 폭).
              모바일에선 한 단계 콤팩트 (w-4 h-3) 로 textarea 폭 보호. */}
          {(hasPrevUser || hasNextUser) && (
            <div className={`flex flex-col self-center ${isMobile ? 'gap-0 mr-0' : 'gap-0.5 mr-0.5'}`}>
              <button
                type="button"
                onClick={() => onJumpPrevUser?.()}
                disabled={!hasPrevUser}
                className={`flex items-center justify-center rounded text-surface-500 hover:text-gray-200 hover:bg-surface-700/60 disabled:opacity-25 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-surface-500 transition-colors ${
                  isMobile ? 'w-4 h-3.5' : 'w-5 h-4'
                }`}
                title={t('previousQuestion', { shortcut: navShortcutLabel })}
                aria-label={t('previousQuestion', { shortcut: navShortcutLabel })}
              >
                <svg className={isMobile ? 'w-2.5 h-2.5' : 'w-3 h-3'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 15l7-7 7 7" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => onJumpNextUser?.()}
                disabled={!hasNextUser}
                className={`flex items-center justify-center rounded text-surface-500 hover:text-gray-200 hover:bg-surface-700/60 disabled:opacity-25 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-surface-500 transition-colors ${
                  isMobile ? 'w-4 h-3.5' : 'w-5 h-4'
                }`}
                title={t('nextQuestion', { shortcut: navShortcutLabel })}
                aria-label={t('nextQuestion', { shortcut: navShortcutLabel })}
              >
                <svg className={isMobile ? 'w-2.5 h-2.5' : 'w-3 h-3'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>
          )}
          {/* Stop always aborts immediately, including active Pi tool calls. */}
          {isSafeStopAvailable && onSafeStop && (
            <button
              type="button"
              onClick={onSafeStop}
              className={`bg-transparent hover:bg-red-500/10 rounded-xl transition-all shrink-0 text-red-400 self-end focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ${
                isMobile ? 'p-1.5 m-0.5' : 'p-2 m-1'
              }`}
              title={t('stopImmediately')}
              aria-label={t('stopImmediately')}
            >
              <svg className={isMobile ? 'w-4 h-4' : 'w-5 h-5'} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="7" y="7" width="10" height="10" rx="2" />
              </svg>
            </button>
          )}
          {/* Non-Pi fallback retains the existing immediate abort behavior. */}
          {isStreaming && !isSafeStopAvailable && (
            <button
              onClick={() => {
                // Stop streaming AND restore queued messages to input
                const sid = useChatStore.getState().sessionId;
                if (sid) {
                  const queue = useChatStore.getState().messageQueue[sid];
                  if (queue && queue.length > 0) {
                    const restored = [input, ...queue].filter(Boolean).join('\n\n');
                    setDraftInput(restored, sid);
                    useChatStore.getState().clearSessionQueue(sid);
                    if (textareaRef.current) {
                      const el = textareaRef.current;
                      requestAnimationFrame(() => applyTextareaHeight(el));
                    }
                  }
                }
                onAbort();
              }}
              className={`bg-transparent hover:bg-red-500/10 rounded-xl transition-all shrink-0 text-red-400 self-end ${
                isMobile ? 'p-1.5 m-0.5' : 'p-2 m-1'
              }`}
              title="Stop"
              aria-label={t('stopResponse')}
            >
              <svg className={isMobile ? 'w-4 h-4' : 'w-5 h-5'} fill="currentColor" viewBox="0 0 24 24">
                <rect x="7" y="7" width="10" height="10" rx="2" />
              </svg>
            </button>
          )}
          {/* Send/Queue button — hidden when streaming with empty input (Stop takes its place) */}
          {!(isStreaming && !input.trim() && attachments.length === 0) && (
            <button
              onClick={() => { void handleSubmit(); }}
              disabled={uploadProgress !== null || (!input.trim() && attachments.length === 0)}
              className={`rounded-xl transition-all disabled:cursor-not-allowed shrink-0 active:scale-95 group self-end ${
                isMobile ? 'p-1.5 m-0.5' : 'p-2 m-1'
              } ${
                isStreaming && (input.trim() || attachments.length > 0)
                  ? 'bg-primary-500/12 hover:bg-primary-500/18 text-primary-300 ring-1 ring-primary-500/20'
                  : 'bg-primary-600/90 hover:bg-primary-500 disabled:bg-transparent disabled:text-surface-600 disabled:shadow-none text-white shadow-[0_4px_12px_rgba(0,0,0,0.12)]'
              }`}
              title={isStreaming ? (isPiStreamingSession ? 'Steer current Pi turn' : 'Add to queue') : 'Send'}
              aria-label={isStreaming ? (isPiStreamingSession ? t('sendToCurrentPi') : t('addToQueue')) : t('sendMessage')}
            >
              {isStreaming && (input.trim() || attachments.length > 0) ? (
                <svg className={isMobile ? 'w-4 h-4' : 'w-5 h-5'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
              ) : (
                <svg className={`transform group-active:translate-x-[1px] group-active:translate-y-[-1px] group-hover:translate-x-[1px] group-hover:translate-y-[-1px] transition-transform ${isMobile ? 'w-4 h-4' : 'w-5 h-5'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
                </svg>
              )}
            </button>
          )}
        </div>
        </div>
      </div>

    </div>
  );
}
