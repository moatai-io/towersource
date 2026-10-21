import { towerHttpUrl } from '../../features/client-connection/connection';
import { ToolStartVoiceCue } from './ToolStartVoiceCue';
import { finalizeDictationForSend } from './dictation-submit';
import { FileOperationFeedback } from '../../features/file-operation-feedback/FileOperationFeedback';
import { uploadScope, reportUploadUnknown, reportUploadFailure, clearFileOperation } from '../../features/file-operation-feedback/feedback';
import { beginAttachmentUpload, hasAttachmentUploads, waitForAttachmentUploads } from '../../utils/attachment-upload-barrier';
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
import { ComposerCapabilitiesMenu } from './ComposerCapabilitiesMenu';
import { updateDictation, type DictationInsertionState } from './dictation-insertion';
import { DictationButton } from './DictationButton';
import { AnswerVoiceToggle } from './AnswerVoiceToggle';
import { SourceReferenceChip } from './SourceReferenceChip';
import { ATTACH_COMPOSER_SOURCE_EVENT, type AttachComposerSourceDetail, type ComposerSourceReference } from '../files/source-inspector/sourceReference';
import { CommandPicker, commandIdentityKey, commandNameFields, filterSlashCommands, hasExactCommandMatch as hasExactSlashCommandMatch } from './CommandPicker';
import { InputResizeHandle, INPUT_MIN_HEIGHT, INPUT_MAX_HEIGHT } from './InputResizeHandle';
import { toastInfo, toastError } from '../../utils/toast';
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
  /** Trusted UI attachment sent as a structured frame field; message text is context only. */
  sourceReference?: ComposerSourceReference;
}

interface InputBoxProps {
  activeTurnStatus?: React.ReactNode;
  /** Freeze a pending welcome before any composer focus, edit or action. */
  onInteraction?: () => void;
  onSend: (message: string, options?: SendOptions) => void;
  onAbort: () => void;
  onStopImmediately?: () => void;
  onAnswerQuestion?: (questionId: string, answer: string) => void;
}

const DRAFT_PREFIX = 'tower:inputDraft:';
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

interface ComposerAction {
  id: string;
  contextRevision: number;
  label: string;
  message: string;
  intent: 'continue' | 'replan';
  risk: 'read_only' | 'reversible';
  origin: 'tower_rule';
  autoEligible: boolean;
  rationaleCode?: string;
}

interface ComposerActionResponse {
  contextRevision: number;
  mode: 'guide';
  source: 'tower_rule';
  recommendedActionId: null;
  actions: ComposerAction[];
  autoMode: { available: false; status: 'coming_soon' };
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

export function InputBox({ onSend, onAbort, onStopImmediately, onAnswerQuestion, onInteraction, activeTurnStatus }: InputBoxProps) {
  const { t, i18n } = useTranslation('chat');
  const [dictationEpoch, setDictationEpoch] = useState(0);
  const dictationAcceptingRef = useRef(false);
  const dictationRange = useRef<DictationInsertionState>({ start: 0, end: 0, owned: '', transcript: '', snapshot: '' });
  const [input, setInput] = useState('');
  const [ghostSuggestion, setGhostSuggestion] = useState('');
  const [ghostSuffix, setGhostSuffix] = useState('');
  const [composerSettings, setComposerSettings] = useState<AiComposerSettings>(DEFAULT_AI_COMPOSER_SETTINGS);
  const [composerActions, setComposerActions] = useState<ComposerActionResponse | null>(null);
  const [showCommands, setShowCommands] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const uploadProgressBySession = useChatStore((state) => state.attachmentUploadProgress);
  const [waitingSessionIds, setWaitingSessionIds] = useState<Set<string>>(() => new Set());
  const waitingSessionIdsRef = useRef(new Set<string>());
  const composerMountedRef = useRef(true);
  useEffect(() => {
    composerMountedRef.current = true;
    return () => { composerMountedRef.current = false; };
  }, []);
  const [sourceReference, setSourceReference] = useState<ComposerSourceReference | null>(null);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [steerExpanded, setSteerExpanded] = useState(false);
  const selectedCommandTriggerRef = useRef<SendOptions['commandTrigger'] | null>(null);
  // 사용자가 InputResizeHandle 로 명시 지정한 높이. null = auto.
  const [manualHeight, setManualHeight] = useState<number | null>(() => loadManualHeight());
  // 모바일 분기 (placeholder 문구 + UI 분기). 미세 jitter 흡수 위해 100ms debounce.
  const isMobile = useMediaQuery('(max-width: 640px)', { debounceMs: 100 });
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
  const uploadProgress = currentSessionId ? uploadProgressBySession[currentSessionId] || null : null;
  const currentSessionProjectId = useSessionStore((s) =>
    s.sessions.find((candidate) => candidate.id === currentSessionId)?.projectId
  );
  const currentSessionCwd = useSessionStore((s) =>
    s.sessions.find((candidate) => candidate.id === currentSessionId)?.cwd
  );
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

  const showQuickReplies = !isStreaming
    && !['queued', 'preparing', 'streaming', 'tool_running', 'stalled', 'closing', 'awaiting_user', 'compacting'].includes(activeTurn.phase)
    && input.trim().length === 0
    && attachments.length === 0
    && visiblePendingInjections.length === 0
    && messages.some((m) => m.role === 'assistant');
  const fallbackActions = useMemo<ComposerAction[]>(() => ([
    { id: 'continue', contextRevision: 0, label: t('quickContinue'), message: t('continueRequest'), intent: 'continue', risk: 'reversible', origin: 'tower_rule', autoEligible: false },
  ]), [t]);
  // The server can still supply a replan/handoff action. Do not surface it as
  // a context-driven suggestion that could be mistaken for /compact.
  const visibleComposerActions = (composerActions?.actions?.length ? composerActions.actions : fallbackActions)
    .filter((action) => action.id !== 'replan');
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

    window.dispatchEvent(new CustomEvent('tower-speech-question', { detail: { sessionId: currentSessionId } }));
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

  useEffect(() => {
    if (!currentSessionId || isStreaming || pendingQuestion || !latestAssistantText) {
      setComposerActions(null);
      return;
    }
    let active = true;
    const controller = new AbortController();
    const token = localStorage.getItem('token');
    const language = i18n.language || 'en';
    const url = `/api/sessions/${encodeURIComponent(currentSessionId)}/composer-actions?language=${encodeURIComponent(language)}`;
    const loadActions = async () => {
      try {
        const response = await fetch(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        });
        const payload = response.ok ? await response.json() as ComposerActionResponse : null;
        if (!active) return;
        const actions = Array.isArray(payload?.actions) ? payload.actions.filter(action => (
          typeof action?.id === 'string'
          && typeof action?.label === 'string'
          && typeof action?.message === 'string'
          && action.message.trim().length > 0
        )).slice(0, 4) : [];
        setComposerActions(payload ? { ...payload, actions } : null);
      } catch (error: any) {
        if (active && error?.name !== 'AbortError') setComposerActions(null);
      }
    };
    void loadActions();
    return () => {
      active = false;
      controller.abort();
    };
  }, [currentSessionId, isStreaming, latestAssistantText, pendingQuestion, i18n.language]);

  // Pre-load slash commands from /api/commands so they're available before first message.
  // Fetch on session changes even if a previous session already populated commands:
  // the server registry is authoritative and project manifests must not inherit
  // stale slash items from another project.
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const tk = localStorage.getItem('token');
    const hdrs: Record<string, string> = {};
    if (tk) hdrs['Authorization'] = `Bearer ${tk}`;
    const params = new URLSearchParams();
    if (currentSessionProjectId) params.set('projectId', currentSessionProjectId);
    if (currentSessionCwd) params.set('cwd', currentSessionCwd);
    fetch(`/api/commands${params.toString() ? `?${params.toString()}` : ''}`, { headers: hdrs, signal: controller.signal })
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
        if (!active) return;
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
      .catch((error) => {
        if (!active || error?.name === 'AbortError') return;
        useChatStore.getState().setSystemInfo({ slashCommands: [] });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [currentSessionId, currentSessionProjectId, currentSessionCwd]);

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
      setSourceReference(null);
      // Save only if the draft ref still belongs to that previous session. If a
      // pending React state update from another session is currently visible, do
      // not write it into the previous/new session's localStorage bucket.
      if (prevSessionId !== null && draftSessionRef.current === prevSessionId) {
        saveDraft(prevSessionId, draftValueRef.current);
      }
      // Load draft for new session
      const restored = loadDraft(currentSessionId);
      setDraftInput(restored, currentSessionId, false);
      if (restored.trim()) onInteraction?.();
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
  }, [input, manualHeight, defaultMaxH]);

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
        window.dispatchEvent(new CustomEvent('tower-speech-question', { detail: { sessionId: currentSessionId } }));
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

  // Attach a source-backed HTML selection from the file preview. This is a
  // reference-only attachment in Phase 1; it does not restrict ordinary chat
  // write authority.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<AttachComposerSourceDetail>).detail;
      if (!detail?.reference || detail.reference.version !== 1) return;
      setSourceReference(detail.reference);
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    window.addEventListener(ATTACH_COMPOSER_SOURCE_EVENT, handler);
    return () => window.removeEventListener(ATTACH_COMPOSER_SOURCE_EVENT, handler);
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

  const dictationSendPending = useRef(false);
  const handleSubmit = async (immediateInput?: string) => {
    if (dictationSendPending.current) return;
    const voiceSession = useSessionStore.getState().activeSessionId;
    dictationSendPending.current = true;
    let voiceReady = false;
    try { const result = finalizeDictationForSend(voiceSession); voiceReady = typeof result === 'boolean' ? result : await result; if (typeof result !== 'boolean') immediateInput = textareaRef.current?.value ?? immediateInput; } finally { dictationSendPending.current = false; }
    if (!voiceReady || useSessionStore.getState().activeSessionId !== voiceSession) return;
    // Reject duplicate sends, including the originating session's upload wait.
    if (isSubmittingRef.current || waitingSessionIdsRef.current.has(useSessionStore.getState().activeSessionId || '')) return;
    // Paste/input events can be followed by Enter before React commits the new
    // controlled value. The textarea's live DOM value is authoritative for a
    // keyboard submit, preventing the first Enter from seeing stale/empty state.
    const trimmed = (typeof immediateInput === 'string' ? immediateInput : input).trim();
    const submittingSessionId = useSessionStore.getState().activeSessionId;
    if (submittingSessionId && hasAttachmentUploads(submittingSessionId)) {
      waitingSessionIdsRef.current.add(submittingSessionId);
      setWaitingSessionIds(new Set(waitingSessionIdsRef.current));
      let switched = false;
      const unsubscribe = useSessionStore.subscribe((state) => {
        if (state.activeSessionId !== submittingSessionId) switched = true;
      });
      try {
        const success = await waitForAttachmentUploads(submittingSessionId);
        // Do not send from a stale composer, or discard edits made while waiting.
        if (!success || switched || !composerMountedRef.current || useSessionStore.getState().activeSessionId !== submittingSessionId
          || (textareaRef.current && textareaRef.current.value.trim() !== trimmed)) return;
      } finally {
        unsubscribe();
        waitingSessionIdsRef.current.delete(submittingSessionId);
        if (composerMountedRef.current) setWaitingSessionIds(new Set(waitingSessionIdsRef.current));
      }
    }
    const attachments = useChatStore.getState().attachments;
    const hasContent = trimmed || attachments.length > 0;
    if (!hasContent) return;

    const dedupeText = `${buildMessageFrom(trimmed, attachments).trim()}${sourceReference ? `\n[source:${sourceReference.id}]` : ''}`;
    const last = lastSubmitRef.current;
    if (last && last.text === dedupeText && Date.now() - last.at < 10_000) {
      return;
    }
    lastSubmitRef.current = { text: dedupeText, at: Date.now() };

    isSubmittingRef.current = true;
    // Seal this recording before clearing the draft. Late final events cannot restore sent text.
    dictationAcceptingRef.current = false;
    setDictationEpoch(epoch => epoch + 1);
    try {
      if (pendingQuestion && attachments.length === 0 && onAnswerQuestion) {
        setDraftInput('');
        setShowCommands(false);
        onAnswerQuestion(pendingQuestion.questionId, trimmed);
        return;
      }

      // Clear UI immediately to prevent double-submit
      const currentAttachments = [...attachments];
      const currentSourceReference = sourceReference;
      if (currentSourceReference) {
        // The immutable user bubble records the submitted reference. Never
        // restore it to the composer automatically: stale chips invite an
        // accidental second bounded edit and previously caused repeat errors.
        setSourceReference(null);
      }
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
        ? { commandTrigger: selectedCommandTriggerRef.current, ...(currentSourceReference ? { sourceReference: currentSourceReference } : {}) }
        : currentSourceReference
          ? { sourceReference: currentSourceReference }
          : undefined;
      selectedCommandTriggerRef.current = null;

      // Read from the authoritative per-session streaming store synchronously.
      // This avoids double-sends on fast Enter presses and keeps queue behavior
      // aligned with the sidebar/tool chips.
      window.dispatchEvent(new CustomEvent('tower-speech-question', { detail: { sessionId: currentSessionId } }));
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
    onInteraction?.();
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
        const sessionId = useSessionStore.getState().activeSessionId;
        if (!sessionId) {
          toastInfo(t('selectSessionBeforeAttach'));
          return;
        }
        const { transferSessionDrop } = await import('../../features/file-exchange/fileExchangeSessionDrop');
        const transfer = await transferSessionDrop(exchangeRaw, sessionId);
        if (!transfer) {
          toastInfo(t('attachFailed'));
          return;
        }
        const { payload, receipt } = transfer;
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
    if (files.length === 0) return;
    const activeSessionId = useSessionStore.getState().activeSessionId;
    if (!activeSessionId) {
      toastInfo(t('selectSessionBeforeAttach'));
      return;
    }
    clearFileOperation(uploadScope('attachment', String(activeSessionId)));
    const finish = beginAttachmentUpload(activeSessionId);
    try {
      finish(await uploadFilesForSession(files, activeSessionId));
    } catch {
      reportUploadUnknown(uploadScope('attachment', String(activeSessionId)));
      finish(false);
    } finally {
      if (!hasAttachmentUploads(activeSessionId)) {
        useChatStore.getState().setAttachmentUploadProgress(activeSessionId, null);
      }
    }
  };

  const uploadFilesForSession = async (files: File[], activeSessionId: string): Promise<boolean> => {
    const setUploadProgress = (progress: UploadProgressSnapshot | null) => {
      useChatStore.getState().setAttachmentUploadProgress(activeSessionId, progress);
    };
    setUploadProgress({ phase: 'processing', loadedBytes: 0,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0), percent: 0,
      completedFiles: 0, totalFiles: files.length, currentFileName: files[0]?.name || '' });
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
    try {
      const token = localStorage.getItem('token');
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
          url: towerHttpUrl(`/api/session-attachments/${encodeURIComponent(activeSessionId)}`),
          token,
          files: filesInBatch,
          completedBytes,
          totalBytes,
          completedFiles,
          totalFiles: optimized.files.length,
          onProgress: setUploadProgress,
        });
        uploadFailures.push(...(data.failures || []));
        for (const attachment of (data.attachments || [])) {
          useChatStore.getState().addAttachment({
            id: `upload-${attachment.id}`,
            type: 'file',
            label: attachment.name,
            content: attachment.promotedUri || attachment.uri,
            size: attachment.sizeBytes,
            mimeType: attachment.mimeType || undefined,
            sessionAttachmentId: attachment.status === 'project_file' ? undefined : attachment.id,
            expiresAt: attachment.expiresAt || undefined,
          }, activeSessionId);
        }
        completedBytes += batchBytes;
        completedFiles += filesInBatch.length;
      }
      if (uploadFailures.length > 0) {
        reportUploadFailure(uploadScope('attachment', String(activeSessionId)), uploadFailures.length, 0, uploadFailures);
      }
      return uploadFailures.length === 0;
    } catch (error) {
      reportUploadUnknown(uploadScope('attachment', String(activeSessionId)));
      return false;
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
    <div data-chat-composer className="relative min-w-0 w-full max-w-full" onFocusCapture={onInteraction} onPointerDownCapture={onInteraction} onClickCapture={onInteraction}>
      <FileOperationFeedback scope={uploadScope('attachment', String(currentSessionId))} />
      {/* Turn/runtime status */}
      {turnStatusText(activeTurn.phase, hasQueue, t) && (
        <div className="relative z-[2] mb-2">
          <div className="tower-composer-status flex items-center gap-2 border-b border-surface-700/45 px-1 pb-2 text-[13px] text-surface-400">
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
                className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-primary-400 transition-colors hover:bg-primary-500/10 hover:text-primary-300"
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
            <div className="mt-1.5 overflow-hidden rounded-lg border border-surface-700/50 bg-surface-900">
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

      {/* Pending steering and quick replies share one floating stack above the composer. */}
      <div
        className="relative min-w-0 max-w-full"
      >
        <div
          data-testid="floating-composer-companions"
          className="pointer-events-none absolute inset-x-0 bottom-full z-20 flex flex-col items-start gap-2 bg-transparent pb-2"
        >
        {visiblePendingInjections.length === 0 && activeTurnStatus && (
          <div data-testid="floating-active-turn-status">{activeTurnStatus}</div>
        )}
        {visiblePendingInjections.length > 0 && (
          <div
            className="tower-steering-sheet pointer-events-auto relative w-fit max-w-full rounded-xl"
            aria-label={t('pendingSteering')}
          >
            <div className="pointer-events-auto flex items-start gap-2 px-3 py-2 sm:px-4 text-[13px]">
              <span className="tower-steering-spinner mt-1 w-2.5 h-2.5 border-[1.5px] rounded-full animate-spin shrink-0" />
              <button
                type="button"
                onClick={() => setSteerExpanded((v) => !v)}
                className={`tower-steering-text min-w-0 flex-1 text-left leading-relaxed ${
                  steerExpanded ? 'max-h-[min(25vh,12rem)] overflow-y-auto whitespace-pre-wrap' : 'truncate'
                }`}
                title={steerExpanded ? t('collapse') : pendingInjectionText}
                aria-expanded={steerExpanded}
              >
                <span className="mr-2 text-[12px] font-semibold opacity-75">{t('pendingSteeringLabel')}</span>
                {steerExpanded ? (
                  <span className="flex flex-col gap-0.5">
                    {visiblePendingInjections.map((it) => (
                      <span key={it.id} className="whitespace-pre-wrap break-words">
                        {it.text}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span>{pendingInjectionTexts.join(' · ').replace(/\n/g, ' ')}</span>
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
          <div data-testid="floating-quick-replies" className={`pointer-events-none flex max-w-full items-center gap-1.5 overflow-x-auto bg-transparent [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${isMobile ? 'px-1' : 'px-2'}`} aria-label={t('composerActions')}>
            {visibleComposerActions.map((action) => (
              <button
                key={`${action.contextRevision}:${action.id}`}
                type="button"
                onClick={() => sendQuickReply(action.message)}
                className="pointer-events-auto shrink-0 rounded-full border border-surface-700/70 bg-surface-900 px-2.5 py-1 text-[13px] font-medium text-gray-300 hover:border-surface-600 hover:bg-surface-800/80 hover:text-gray-100 active:bg-surface-700/70"
                data-origin={action.origin}
                data-intent={action.intent}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}

        </div>

        <div
        data-tour-id="chat-input"
        className={`tower-input-shell relative z-10 min-w-0 max-w-full rounded-xl border bg-surface-800 transition-[border-color,background-color,margin-top] duration-150 ${
          isDragOver
            ? 'border-primary-500/55 bg-primary-900/10'
            : 'border-surface-700/70 hover:border-surface-600 focus-within:border-primary-500/55'
        }`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Drop overlay */}
        {isDragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-primary-900/20 pointer-events-none">
            <span className="text-[15px] text-primary-300 font-medium">{t('dropHere', { defaultValue: '파일을 여기에 놓으세요.' })}</span>
          </div>
        )}

        {showCommands && (
          <CommandPicker
            commands={filteredCommands}
            selectedIndex={selectedIndex}
            onSelect={selectCommand}
            onHover={setSelectedIndex}
            anchorRef={textareaRef}
          />
        )}

        {/* Upload progress, file attachments, and source references */}
        {(uploadProgress || attachments.length > 0 || sourceReference) && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5 pb-0.5">
            {uploadProgress && <UploadProgressChip progress={uploadProgress} />}
            {waitingSessionIds.has(currentSessionId || '') && (
              <span role="status" className="text-xs text-surface-400">{t('sendAfterUpload')}</span>
            )}
            {sourceReference && (
              <SourceReferenceChip reference={sourceReference} onRemove={() => setSourceReference(null)} />
            )}
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

        <div className={`flex flex-wrap items-end relative [&>*]:order-2 ${isMobile ? 'gap-0.5 px-1.5 py-1' : 'gap-1 p-2'}`}>
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
          <ComposerCapabilitiesMenu
            commands={slashCommands}
            projectId={activeSession?.projectId}
            sessionId={currentSessionId}
            attachmentDisabled={isStreaming || uploadProgress !== null}
            onAttach={() => fileInputRef.current?.click()}
            onSelectSkill={(command) => {
              selectedCommandTriggerRef.current = 'picker';
              const prefix = `/${command.replace(/^\//, '')}`;
              setDraftInput(`${prefix} ${input.replace(/^\/[^\s]*\s?/, '')}`);
              setShowCommands(false);
              requestAnimationFrame(() => textareaRef.current?.focus());
            }}
          />
          <div className="relative min-w-0 !order-1 basis-full w-full">
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
            className={`relative z-[1] block min-w-0 w-full max-w-full overflow-x-hidden bg-transparent border-none py-3 text-input-size text-gray-100 placeholder:text-surface-500 placeholder:italic resize-none focus:outline-none focus:ring-0 min-h-[48px] overscroll-contain ${
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

          <div className="ml-auto flex items-center gap-1">
          <DictationButton key={`${currentSessionId ?? 'no-session'}:${dictationEpoch}`} sessionId={currentSessionId} mobile={isMobile} disabled={uploadProgress !== null} onStart={() => {
            window.dispatchEvent(new Event('tower-speech-recording'));
            dictationAcceptingRef.current = true;
            dictationRange.current = { start: textareaRef.current?.selectionStart ?? input.length, end: textareaRef.current?.selectionEnd ?? input.length, owned: '', transcript: '', snapshot: input };
          }} onText={(text) => {
            if (!dictationAcceptingRef.current) return;
            const result = updateDictation(draftValueRef.current, text, dictationRange.current);
            const el = textareaRef.current;
            const followTail = !el || document.activeElement !== el || el.selectionStart >= el.value.length - 1;
            const selection = el ? { start: el.selectionStart, end: el.selectionEnd } : null;
            dictationRange.current = result.state;
            setDraftInput(result.value);
            requestAnimationFrame(() => {
              const textarea = textareaRef.current;
              if (!textarea) return;
              applyTextareaHeight(textarea);
              if (followTail) {
                textarea.setSelectionRange(result.state.end, result.state.end);
                textarea.scrollTop = textarea.scrollHeight;
              } else if (selection) {
                textarea.setSelectionRange(selection.start, selection.end);
              }
            });
          }} />
          <ToolStartVoiceCue sessionId={currentSessionId} />
          <AnswerVoiceToggle sessionId={currentSessionId} />
          </div>
          {/* Stop always aborts immediately, including active Pi tool calls. */}
          {isSafeStopAvailable && onStopImmediately && (
            <button
              type="button"
              onClick={() => { window.dispatchEvent(new Event('tower-speech-stop')); onStopImmediately(); }}
              className={`bg-transparent hover:bg-red-500/10 rounded-xl transition-all shrink-0 text-red-400 self-end focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ${
                isMobile ? 'min-h-12 min-w-12 p-2.5 m-0.5' : 'p-2 m-1'
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
          {isStreaming && !(isSafeStopAvailable && onStopImmediately) && (
            <button
              onClick={() => {
                window.dispatchEvent(new Event('tower-speech-stop'));
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
                isMobile ? 'min-h-12 min-w-12 p-2.5 m-0.5' : 'p-2 m-1'
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
          {!(isStreaming && !input.trim() && attachments.length === 0 && !uploadProgress) && (
            <button
              type="button"
              onPointerDown={(event) => {
                // Keep the keyboard/viewport stable until click is dispatched.
                // Submit only on click so canceled gestures cannot send messages.
                if (event.button === 0 && document.activeElement === textareaRef.current) event.preventDefault();
              }}
              onMouseDown={(event) => {
                if (event.button === 0 && document.activeElement === textareaRef.current) event.preventDefault();
              }}
              onClick={() => { void handleSubmit(textareaRef.current?.value); }}
              disabled={waitingSessionIds.has(currentSessionId || '') || (!input.trim() && attachments.length === 0 && !uploadProgress)}
              className={`inline-flex items-center justify-center rounded-xl transition-colors disabled:cursor-not-allowed shrink-0 self-end ${
                isMobile ? 'h-12 w-12 p-0' : 'h-10 w-10 p-0'
              } ${
                isStreaming && (input.trim() || attachments.length > 0)
                  ? 'bg-primary-500/12 hover:bg-primary-500/18 text-primary-300 ring-1 ring-primary-500/20'
                  : 'bg-primary-600 hover:bg-primary-500 disabled:bg-transparent disabled:text-surface-600 text-white'
              }`}
              title={isStreaming ? (isPiStreamingSession ? 'Steer current Pi turn' : 'Add to queue') : 'Send'}
              aria-label={isStreaming ? (isPiStreamingSession ? t('sendToCurrentPi') : t('addToQueue')) : t('sendMessage')}
            >
              {isStreaming && (input.trim() || attachments.length > 0) ? (
                <svg className={isMobile ? 'w-4 h-4' : 'w-5 h-5'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
