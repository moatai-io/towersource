import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAiPanelStore, fetchPanelThreads, createPanelThread, deletePanelThread, fetchThreadMessages } from '../../stores/ai-panel-store';
import { useSessionStore } from '../../stores/session-store';
import type { ChatMessage, ContentBlock } from '../../stores/chat-store';
import { getThinkingLabel, getToolActivityLabel, getToolLabel, getToolSummary, normalizeContentBlocks } from '../../utils/message-parser';
import { safeStr } from '../shared/parse-loose-json';
import { normalizePendingQuestion } from '../../utils/pending-question';
import { generateUUID } from '../../utils/uuid';
import { RichContent } from '../shared/RichContent';
import { FloatingQuestionCard } from '../chat/FloatingQuestionCard';
import { ToolUseCard } from '../chat/ToolUseCard';
import { ResizeHandle, MIN_WIDTH, MAX_WIDTH } from '../layout/ResizeHandle';
import { RunIndicator } from '../common/RunIndicator';

const AI_PANEL_WIDTH_KEY = 'tower:ai-panel:width';
const AI_PANEL_DEFAULT_WIDTH = 360;

type CadSelectionLookup = 'none' | 'text' | 'block' | 'entity' | 'semantic' | 'miss' | 'geometry' | 'geometry-tile';

type CadSelectionKind = 'view-candidate' | 'evidence' | 'entity' | 'area' | 'semantic-object';

interface CadSelectionChangeDetail {
  path: string;
  cadModelArtifactPath?: string;
  cadGeometryManifestPath?: string;
  view?: {
    candidateId?: string;
    viewId?: string;
    label?: string;
    kind?: 'overview' | 'layout' | 'view' | 'title-block' | 'table' | 'detail';
    bbox?: { minX: number; minY: number; maxX: number; maxY: number };
  };
  viewport?: {
    zoom: number;
    pan: { x: number; y: number };
  };
  selection: {
    type: CadSelectionKind;
    primitiveId?: string;
    label?: string;
    bounds?: [number, number, number, number];
    entityId?: string;
    textId?: string;
    blockInstanceId?: string;
    semanticObjectId?: string;
    cadModelArtifactPath?: string;
    handle?: string;
    block?: string;
    layer?: string;
    text?: string;
    confidence?: string;
    lookup?: CadSelectionLookup;
  };
}

const currentCadSelectionByPath = new Map<string, CadSelectionChangeDetail>();
let pendingCadWorkbenchAction: { path: string; prompt: string } | null = null;

function clampAiPanelWidth(width: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(width)));
}

function loadAiPanelWidth(): number {
  try {
    const raw = localStorage.getItem(AI_PANEL_WIDTH_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : AI_PANEL_DEFAULT_WIDTH;
    return Number.isFinite(parsed) ? clampAiPanelWidth(parsed) : AI_PANEL_DEFAULT_WIDTH;
  } catch {
    return AI_PANEL_DEFAULT_WIDTH;
  }
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
  return `${Math.floor(diff / 86400_000)}d`;
}

// ── Thread List ──

function ThreadList({ onSelectThread, onNewThread, onNewProjectThread, onDeleteThread, canCreateProjectThread }: {
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onNewProjectThread?: () => void;
  onDeleteThread: (id: string) => Promise<void>;
  canCreateProjectThread?: boolean;
}) {
  const { t } = useTranslation('rooms');
  const threads = useAiPanelStore((s) => s.threads);
  const activeThreadId = useAiPanelStore((s) => s.activeThreadId);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-800">
        <span className="text-[14px] font-medium text-gray-400">{t('threads')}</span>
        <div className="flex items-center gap-1">
          {canCreateProjectThread && onNewProjectThread && (
            <button
              onClick={onNewProjectThread}
              className="tone-action tone-success rounded px-1.5 py-1 text-[12px] font-medium"
              title="New shared project thread"
            >
              shared project
            </button>
          )}
          <button
            onClick={onNewThread}
            className="p-1 hover:bg-surface-700 rounded transition-colors text-gray-400 hover:text-gray-200"
            title={t('newThread')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {threads.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <p className="text-[14px] text-gray-600">{t('noThreadsYet')}</p>
          </div>
        ) : (
          threads.map((t) => {
            const isChannelAi = t.label === 'channel_ai';
            const isAgent = t.label === 'agent';
            const isProjectThread = t.aiPanelScope === 'project' || t.label === 'project_ai';
            const isSessionThread = t.aiPanelScope === 'session' || (!!t.parentSessionId && !isAgent);
            const isOwnProjectThread = isProjectThread && t.label === 'ai_thread';
            const isSharedInPanel = isChannelAi || (isProjectThread && t.visibility === 'project');
            const accessBadge = isSharedInPanel ? 'shared' : isOwnProjectThread ? 'mine' : 'local';
            return (
              <div
                key={t.id}
                className={`group border-b border-surface-800/50 transition-colors ${
                  activeThreadId === t.id
                    ? 'bg-surface-700/60 text-gray-200'
                    : 'text-gray-400 hover:bg-surface-800/60 hover:text-gray-300'
                }`}
              >
                <div className="flex items-stretch">
                  <button
                    onClick={() => { setConfirmDeleteId(null); onSelectThread(t.id); }}
                    className="min-w-0 flex-1 px-3 py-2.5 text-left"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[14px] font-medium truncate">
                        {isChannelAi && (
                          <span className="mr-1 text-[11px] font-bold text-cyan-300 bg-cyan-500/15 px-1 rounded align-middle">
                            channel
                          </span>
                        )}
                        {isAgent && (
                          <span className="mr-1 text-[11px] font-bold text-violet-300 bg-violet-500/15 px-1 rounded align-middle">
                            agent
                          </span>
                        )}
                        {isProjectThread && (
                          <span className="tone-pill tone-success mr-1 text-[11px] font-bold px-1 rounded align-middle">
                            project
                          </span>
                        )}
                        <span className={`tone-pill mr-1 text-[11px] font-bold px-1 rounded align-middle ${isSharedInPanel ? 'tone-warning' : 'tone-muted'}`}>
                          {accessBadge}
                        </span>
                        {isSessionThread && !isAgent && !isChannelAi && !isProjectThread && (
                          <span className="mr-1 text-[11px] font-bold text-blue-300 bg-blue-500/15 px-1 rounded align-middle">
                            session
                          </span>
                        )}
                        {t.name}
                      </span>
                      <span className="text-[12px] text-gray-600 shrink-0">{formatRelativeTime(t.updatedAt)}</span>
                    </div>
                    <div className="text-[12px] text-gray-600 mt-0.5">
                      {[
                        t.turnCount ? `${t.turnCount} turns` : null,
                        t.engine && t.engine !== 'claude' ? t.engine : null,
                        isSharedInPanel ? 'shared with project' : isOwnProjectThread ? 'my project thread' : 'only visible here',
                        isProjectThread ? 'project thread' : null,
                        isAgent ? 'subagent' : null,
                      ].filter(Boolean).join(' · ') || '아직 대화 없음'}
                    </div>
                  </button>
                  <div className="flex items-center pr-2">
                    {confirmDeleteId === t.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={async (e) => { e.stopPropagation(); await onDeleteThread(t.id); setConfirmDeleteId(null); }}
                          className="rounded px-1.5 py-1 text-[12px] font-medium text-red-300 hover:bg-red-500/15"
                          aria-label={`Confirm delete thread ${t.name}`}
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }}
                          className="rounded px-1.5 py-1 text-[12px] text-gray-500 hover:bg-surface-700 hover:text-gray-300"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(t.id); }}
                        className="rounded p-1 text-gray-700 opacity-0 transition-all hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100 focus:opacity-100"
                        title="Delete thread"
                        aria-label={`Delete thread ${t.name}`}
                      >
                        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Message Bubble (lightweight) ──

function PanelToolChip({ block, isLast, isStreaming, onFileClick }: { block: ContentBlock; isLast: boolean; isStreaming: boolean; onFileClick?: (path: string) => void }) {
  const toolUse = block.toolUse;
  const [expanded, setExpanded] = useState(false);
  if (!toolUse?.name) return null;

  const name = safeStr(toolUse.name);
  const input = toolUse.input || {};
  const result = toolUse.result;
  const summary = getToolSummary(name, input);
  const activityLabel = getToolActivityLabel(name, input);
  const label = getToolLabel(name);
  const running = !result && isStreaming && isLast;

  return (
    <div className="my-1.5 max-w-full">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-surface-700/35 bg-surface-800/25 px-2 py-0.5 text-[12px] text-surface-400 transition-colors hover:border-surface-600/60 hover:bg-surface-800/50"
        title={running ? `${activityLabel} · ${summary} · ${name}` : `${label} · ${summary} · ${name}`}
      >
        <svg className="h-3 w-3 shrink-0 text-surface-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
        </svg>
        {running && <RunIndicator size="xs" label="" className="shrink-0 text-primary-400" />}
        <span className="min-w-0 truncate font-medium text-surface-400">{running ? activityLabel : summary}</span>
        {result && (
          <svg className="tone-success tone-text h-2.5 w-2.5 shrink-0 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        )}
      </button>
      {expanded && (
        <div className="mt-1">
          <ToolUseCard
            toolUseId={toolUse.id}
            name={name}
            input={input}
            result={result}
            onFileClick={onFileClick}
            compact
            defaultExpanded
          />
        </div>
      )}
    </div>
  );
}

function PanelMessage({ message, onFileClick, isStreaming }: { message: ChatMessage; onFileClick?: (path: string) => void; isStreaming: boolean }) {
  const isUser = message.role === 'user';
  const lastToolIndex = message.content.map((b, i) => b.type === 'tool_use' && b.toolUse ? i : -1).filter((i) => i >= 0).pop() ?? -1;

  return (
    <div className={`px-3 py-2.5 ${isUser ? 'bg-surface-800/20' : ''}`}>
      <div className="flex items-start gap-2.5">
        <div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${isUser ? 'bg-blue-500/10 text-blue-300' : 'tone-pill tone-success'}`}>
          {isUser ? 'U' : 'AI'}
        </div>
        <div className="min-w-0 flex-1 text-[15px] leading-relaxed text-gray-200">
          {message.content.map((block, i) => {
            if (block.type === 'text' && block.text) {
              return <RichContent key={i} text={block.text} onFileClick={onFileClick} />;
            }
            if (block.type === 'tool_use' && block.toolUse) {
              return <PanelToolChip key={i} block={block} isLast={i === lastToolIndex} isStreaming={isStreaming} onFileClick={onFileClick} />;
            }
            if (block.type === 'thinking' && block.thinking) {
              const title = getThinkingLabel(block.thinking.title, block.thinking.text);
              return (
                <details key={i} className="my-1.5 rounded-md border border-surface-800/70 bg-surface-900/50 px-2 py-1">
                  <summary className="cursor-pointer truncate text-[13px] text-gray-500">{title}</summary>
                  <div className="mt-1 text-[13px] text-gray-600">{block.thinking.text?.slice(0, 300)}</div>
                </details>
              );
            }
            return null;
          })}
        </div>

      </div>
    </div>
  );
}

// ── Thread View ──

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

function cadSelectionTitle(selection?: CadSelectionChangeDetail | null): string | null {
  if (!selection) return null;
  const s = selection.selection;
  return s.label || s.text || s.block || selection.view?.label || s.semanticObjectId || s.entityId || s.handle || null;
}

function cadSelectionMeta(selection?: CadSelectionChangeDetail | null): string {
  if (!selection) return '';
  const s = selection.selection;
  return [
    s.semanticObjectId ? `semantic ${s.semanticObjectId}` : null,
    s.entityId ? `entity ${s.entityId}` : null,
    s.handle ? `handle ${s.handle}` : null,
    s.block ? `block ${s.block}` : null,
    s.layer ? `layer ${s.layer}` : null,
    s.lookup ? `lookup ${s.lookup}` : null,
  ].filter(Boolean).join(' · ');
}

function buildSurfaceHint() {
  const anchor = useAiPanelStore.getState().fileAnchor;
  if (!anchor?.path) return undefined;
  const isCad = anchor.language === 'cad' || /\.(dxf|dwg)$/i.test(anchor.path);
  const cadSelection = isCad ? currentCadSelectionByPath.get(anchor.path) : undefined;
  return {
    type: anchor.language === 'automation' ? 'automation' : 'file',
    title: anchor.title || basename(anchor.path),
    path: anchor.path,
    language: anchor.language,
    ...(isCad ? {
      harness: 'cad',
      capabilities: [
        'preview',
        'qa',
        'text-index',
        'layer-summary',
        'block-index',
        'rfq-intake',
        'dry-run-change-planned',
      ],
      cadSelection,
    } : {}),
  };
}

function ThreadView({ onBack, onEnsureThread, onFileClick, draft = false }: {
  onBack: () => void;
  onEnsureThread?: () => Promise<string | null>;
  onFileClick?: (path: string) => void;
  draft?: boolean;
}) {
  const { t } = useTranslation('rooms');
  const messages = useAiPanelStore((s) => s.messages);
  const isStreaming = useAiPanelStore((s) => s.isStreaming);
  const pendingQuestion = useAiPanelStore((s) => s.pendingQuestion);
  const activeThreadId = useAiPanelStore((s) => s.activeThreadId);
  const threads = useAiPanelStore((s) => s.threads);
  const contextType = useAiPanelStore((s) => s.contextType);
  const fileAnchor = useAiPanelStore((s) => s.fileAnchor);
  const [input, setInput] = useState('');
  const [currentCadSelection, setCurrentCadSelection] = useState<CadSelectionChangeDetail | null>(null);
  const [creatingThread, setCreatingThread] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const isCadFileAnchor = fileAnchor?.language === 'cad' || /\.(dxf|dwg)$/i.test(fileAnchor?.path || '');

  useEffect(() => {
    if (!isCadFileAnchor || !fileAnchor?.path) {
      setCurrentCadSelection(null);
      return;
    }
    setCurrentCadSelection(currentCadSelectionByPath.get(fileAnchor.path) || null);
  }, [fileAnchor?.path, isCadFileAnchor]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<CadSelectionChangeDetail>).detail;
      if (!detail?.path || !detail.selection) return;
      currentCadSelectionByPath.set(detail.path, detail);
      if (fileAnchor?.path === detail.path) setCurrentCadSelection(detail);
    };
    window.addEventListener('tower:cad-selection-change', handler as EventListener);
    return () => window.removeEventListener('tower:cad-selection-change', handler as EventListener);
  }, [fileAnchor?.path]);

  useEffect(() => {
    const applyAction = (detail?: { path?: string; prompt?: string }) => {
      if (!detail?.prompt || !detail.path || detail.path !== fileAnchor?.path) return false;
      setInput(detail.prompt);
      window.setTimeout(() => inputRef.current?.focus(), 0);
      return true;
    };
    if (pendingCadWorkbenchAction && applyAction(pendingCadWorkbenchAction)) pendingCadWorkbenchAction = null;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; prompt?: string }>).detail;
      if (!applyAction(detail) && detail?.path && detail.prompt) pendingCadWorkbenchAction = { path: detail.path, prompt: detail.prompt };
    };
    window.addEventListener('tower:cad-workbench-action', handler as EventListener);
    return () => window.removeEventListener('tower:cad-workbench-action', handler as EventListener);
  }, [fileAnchor?.path]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [messages.length, pendingQuestion?.questionId]);

  const handleAnswerQuestion = useCallback((questionId: string, answer: string) => {
    const ws = (window as any).__towerWs;
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeThreadId) return;
    ws.send(JSON.stringify({
      type: 'answer_question',
      sessionId: activeThreadId,
      questionId,
      answer,
    }));
    useAiPanelStore.getState().setPendingQuestion(null);
  }, [activeThreadId]);

  const handleSend = useCallback(async (immediateInput?: string) => {
    const text = (typeof immediateInput === 'string' ? immediateInput : input).trim();
    if (!text || creatingThread) return;

    if (pendingQuestion) {
      handleAnswerQuestion(pendingQuestion.questionId, text);
      setInput('');
      return;
    }

    if (isStreaming) return;

    const ws = (window as any).__towerWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    let sessionId = activeThreadId;
    if (!sessionId) {
      if (!onEnsureThread) return;
      setCreatingThread(true);
      try {
        sessionId = await onEnsureThread();
      } finally {
        setCreatingThread(false);
      }
      if (!sessionId) return;
    }

    const msgId = generateUUID();

    // Add user message to panel store immediately
    useAiPanelStore.getState().addMessage({
      id: msgId,
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: Date.now(),
    });

    // Send via WS chat (reuses existing handleChat flow).
    // The user-visible message remains clean; current-screen information is
    // sent as a non-persistent hint for the backend to prepend only to the
    // engine prompt.
    // panelChat flag prevents backend from overwriting client's main sessionId.
    ws.send(JSON.stringify({
      type: 'chat',
      message: text,
      messageId: msgId,
      sessionId,
      panelChat: true,
      surfaceHint: buildSurfaceHint(),
    }));

    useAiPanelStore.getState().setStreaming(true);
    setInput('');
    inputRef.current?.focus();
  }, [input, activeThreadId, isStreaming, creatingThread, pendingQuestion, handleAnswerQuestion, onEnsureThread]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e.currentTarget instanceof HTMLTextAreaElement ? e.currentTarget.value : input);
    }
  }, [handleSend]);

  const isAutomationAnchor = fileAnchor?.language === 'automation' || fileAnchor?.path?.startsWith('automation:');
  const emptyMessage = isCadFileAnchor
    ? 'CAD Workbench beta'
    : isAutomationAnchor
      ? 'Automation Workbench AI'
      : fileAnchor
        ? 'Ask AI about this file'
        : 'Ask AI anything about this session';
  const promptGroup = isCadFileAnchor
    ? 'cad'
    : isAutomationAnchor
      ? 'automation'
      : fileAnchor
        ? 'file'
        : 'session';
  const samplePrompts = t(`aiPanelSamplePrompts.${promptGroup}`, { returnObjects: true }) as string[];

  const applySamplePrompt = useCallback((prompt: string) => {
    setInput(prompt);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const handleStop = useCallback(() => {
    if (!activeThreadId) return;
    const ws = (window as any).__towerWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'abort',
      sessionId: activeThreadId,
    }));
    useAiPanelStore.getState().setStreaming(false);
    useAiPanelStore.getState().setPendingQuestion(null);
  }, [activeThreadId]);

  return (
    <div className="flex flex-col h-full">
      {/* Thread header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-800 shrink-0">
        {!draft && (
          <button
            onClick={onBack}
            className="p-1 hover:bg-surface-700 rounded transition-colors text-gray-400 hover:text-gray-200"
            aria-label="Back to threads"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-gray-300">
            {activeThread?.name || (draft ? 'New thread' : 'Thread')}
          </div>
          {fileAnchor && (
            <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[12px] text-primary-300/90" title={fileAnchor.path}>
              <span aria-hidden="true">{isCadFileAnchor ? '📐' : isAutomationAnchor ? '⏰' : '📎'}</span>
              <span className="truncate">{isCadFileAnchor ? 'CAD Workbench: ' : isAutomationAnchor ? 'Automation: ' : '현재 파일: '}{fileAnchor.title || basename(fileAnchor.path)}</span>
              {isCadFileAnchor && <span className="shrink-0 rounded-full border border-amber-400/30 bg-amber-400/10 px-1 py-0.5 text-[10px] font-bold text-amber-200">beta</span>}
            </div>
          )}
          {isCadFileAnchor && currentCadSelection && (
            <div className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-cyan-200/90" title={cadSelectionMeta(currentCadSelection)}>
              <span className="shrink-0 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-1.5 py-0.5 font-semibold text-cyan-200">현재 CAD 선택</span>
              <span className="truncate">{cadSelectionTitle(currentCadSelection) || '선택 영역'}</span>
              {cadSelectionMeta(currentCadSelection) && <span className="truncate text-cyan-200/55">· {cadSelectionMeta(currentCadSelection)}</span>}
            </div>
          )}
        </div>
        {isStreaming && (
          <span className="tone-success tone-text flex items-center gap-1 text-[12px]">
            <RunIndicator size="xs" label="" className="tone-success tone-text" />
            running
          </span>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="flex min-h-full flex-col items-center justify-center px-5 py-8 text-center">
            <p className="text-[14px] text-gray-500">{emptyMessage}</p>
            <div className="mt-4 grid w-full gap-2">
              {samplePrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => applySamplePrompt(prompt)}
                  className="rounded-lg border border-surface-700/70 bg-surface-800/35 px-3 py-2 text-left text-[14px] leading-relaxed text-gray-300 transition-colors hover:border-primary-500/40 hover:bg-surface-700/60 hover:text-gray-100"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="py-1">
            {messages.map((msg, i) => (
              <div key={msg.id} className="group">
                <PanelMessage
                  message={msg}
                  isStreaming={isStreaming && msg.role === 'assistant' && i === messages.length - 1}
                  onFileClick={onFileClick}
                />
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-surface-800 px-3 py-2 shrink-0">
        {pendingQuestion && (
          <FloatingQuestionCard
            question={pendingQuestion}
            onAnswer={handleAnswerQuestion}
          />
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={pendingQuestion ? '질문에 답변을 입력하세요…' : t('askAi')}
            rows={1}
            className="flex-1 px-2.5 py-1.5 bg-surface-800 border border-surface-700 rounded-lg text-[14px] text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-primary-500/50 transition-colors resize-none"
            style={{ minHeight: '32px', maxHeight: '80px' }}
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={handleStop}
              className="shrink-0 rounded-lg bg-red-500/10 p-1.5 text-red-300 transition-colors hover:bg-red-500/20"
              aria-label="Stop AI panel response"
              title="Stop"
            >
              <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
                <rect x="5" y="5" width="10" height="10" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              onClick={() => { void handleSend(); }}
              disabled={!input.trim() || creatingThread}
              className="p-1.5 bg-primary-600 hover:bg-primary-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors shrink-0"
              aria-label={creatingThread ? 'Creating thread' : 'Send message'}
            >
              <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19V5m0 0l-7 7m7-7l7 7" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main AI Panel ──

export function AiPanel({ onFileClick }: { onFileClick?: (path: string) => void } = {}) {
  const open = useAiPanelStore((s) => s.open);
  const contextType = useAiPanelStore((s) => s.contextType);
  const contextId = useAiPanelStore((s) => s.contextId);
  const activeThreadId = useAiPanelStore((s) => s.activeThreadId);
  const threads = useAiPanelStore((s) => s.threads);
  const loading = useAiPanelStore((s) => s.loading);
  const fileAnchor = useAiPanelStore((s) => s.fileAnchor);
  const isMobile = useSessionStore((s) => s.isMobile);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeSession = useSessionStore((s) => s.sessions.find((session) => session.id === s.activeSessionId));
  const [panelWidth, setPanelWidth] = useState(loadAiPanelWidth);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; prompt?: string }>).detail;
      if (!detail?.path || !detail.prompt) return;
      pendingCadWorkbenchAction = { path: detail.path, prompt: detail.prompt };
      useAiPanelStore.getState().setOpen(true);
    };
    window.addEventListener('tower:cad-workbench-action', handler as EventListener);
    return () => window.removeEventListener('tower:cad-workbench-action', handler as EventListener);
  }, []);

  const handlePanelResize = useCallback((width: number) => {
    const nextWidth = clampAiPanelWidth(width);
    setPanelWidth(nextWidth);
    try {
      localStorage.setItem(AI_PANEL_WIDTH_KEY, String(nextWidth));
    } catch {}
  }, []);

  // Fetch threads when panel opens. Empty contexts intentionally stay as an
  // unsaved draft until the user sends the first message.
  useEffect(() => {
    if (!open || !contextId) return;
    let cancelled = false;
    useAiPanelStore.getState().setLoading(true);
    fetchPanelThreads(contextType, contextId)
      .then((threads) => {
        if (cancelled) return;
        const store = useAiPanelStore.getState();
        if (store.contextType !== contextType || store.contextId !== contextId) return;
        store.setThreads(threads);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) useAiPanelStore.getState().setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, contextType, contextId]);

  // Load messages when thread is selected
  useEffect(() => {
    if (!activeThreadId) return;
    useAiPanelStore.getState().setLoading(true);
    fetchThreadMessages(activeThreadId)
      .then((msgs) => useAiPanelStore.getState().setMessages(msgs))
      .catch(() => {})
      .finally(() => useAiPanelStore.getState().setLoading(false));
  }, [activeThreadId]);

  // Listen to WS messages for panel session streaming
  useEffect(() => {
    if (!open) return;

    const handler = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        const store = useAiPanelStore.getState();

        // session_meta_update applies to ANY thread in the panel list (e.g. auto-name
        // for a background thread that just completed its first turn). Handle before
        // the activeThreadId gate below so it doesn't get filtered out.
        if (data.type === 'session_meta_update' && data.sessionId && data.updates) {
          const isKnownThread = store.threads.some((t) => t.id === data.sessionId);
          if (isKnownThread) store.updateThreadMeta(data.sessionId, data.updates);
          return;
        }

        if (!store.activeThreadId) return;

        // Only process messages for the active panel thread
        if (data.sessionId && data.sessionId !== store.activeThreadId) return;

        // tower_message is the current broadcast format (ws-handler.ts broadcastTowerMessage).
        // Legacy sdk_message is no longer emitted for assistant/turn_done/compact.
        if (data.type === 'tower_message' && data.message?.type === 'assistant') {
          const towerMsg = data.message;
          const msgId = towerMsg.msgId;
          if (!msgId) return;
          const content: ContentBlock[] = normalizeContentBlocks(towerMsg.content || []);

          // Update existing or add new
          const existing = store.messages.find((m) => m.id === msgId);
          const timestamp = towerMsg.timestamp || Date.now();
          if (existing) {
            store.updateAssistantById(msgId, content, timestamp);
          } else {
            store.addMessage({
              id: msgId,
              role: 'assistant',
              content,
              timestamp,
              parentToolUseId: towerMsg.parentToolUseId,
            });
          }
        }

        // turn_done → streaming complete (fallback to sdk_done below still works)
        if (data.type === 'tower_message' && data.message?.type === 'turn_done') {
          const towerMsg = data.message;
          const turnTimestamp = towerMsg.timestamp || Date.now();
          const ids = Array.isArray(towerMsg.assistantMsgIds) && towerMsg.assistantMsgIds.length > 0
            ? towerMsg.assistantMsgIds
            : (towerMsg.msgId ? [towerMsg.msgId] : []);
          for (const id of ids) {
            const existing = store.messages.find((m) => m.id === id);
            if (existing?.role === 'assistant') {
              store.updateAssistantById(id, existing.content, turnTimestamp);
            }
          }
          store.setStreaming(false);
          store.setPendingQuestion(null);
        }

        if (data.type === 'ask_user' && data.sessionId === store.activeThreadId) {
          const normalizedPendingQuestion = normalizePendingQuestion({
            questionId: data.questionId,
            sessionId: data.sessionId,
            questions: data.questions,
          });
          store.setPendingQuestion(normalizedPendingQuestion);
          store.setStreaming(false);
        }

        if (data.type === 'ask_user_timeout') {
          const pq = store.pendingQuestion;
          if (pq && pq.questionId === data.questionId) {
            store.setPendingQuestion(null);
          }
        }

        if (data.type === 'sdk_done' && data.sessionId === store.activeThreadId) {
          store.setStreaming(false);
          store.setPendingQuestion(null);
        }

        if (data.type === 'session_status' && data.sessionId === store.activeThreadId) {
          store.setStreaming(data.status === 'streaming');
          if (data.status !== 'streaming') {
            store.setPendingQuestion(null);
          }
        }
      } catch {}
    };

    const ws = (window as any).__towerWs;
    if (ws) ws.addEventListener('message', handler);
    return () => { if (ws) ws.removeEventListener('message', handler); };
  }, [open]);

  if (!open) return null;

  const ensureThread = async (scope: 'session' | 'project' = 'session'): Promise<string | null> => {
    if (!contextId) return null;
    const existingId = useAiPanelStore.getState().activeThreadId;
    if (existingId && scope === 'session') return existingId;
    const projectId = activeSession?.projectId || null;
    if (scope === 'project' && !projectId) return null;
    try {
      const thread = await createPanelThread(contextType, contextId, undefined, { scope, projectId });
      useAiPanelStore.getState().addThread({
        ...thread,
        aiPanelScope: scope === 'project' ? 'project' : 'session',
      });
      useAiPanelStore.getState().setActiveThreadId(thread.id);
      useAiPanelStore.getState().setMessages([]);
      useAiPanelStore.getState().setPendingQuestion(null);
      return thread.id;
    } catch (err) {
      console.error('[AiPanel] Failed to create thread:', err);
      return null;
    }
  };

  const handleNewThread = async () => {
    await ensureThread('session');
  };

  const handleNewProjectThread = async () => {
    await ensureThread('project');
  };

  const handleSelectThread = (id: string) => {
    useAiPanelStore.getState().setActiveThreadId(id);
  };

  const handleDeleteThread = async (id: string) => {
    const store = useAiPanelStore.getState();
    const previousThreads = store.threads;
    const wasActive = store.activeThreadId === id;
    store.removeThread(id);
    try {
      await deletePanelThread(id);
    } catch (err) {
      console.error('[AiPanel] Failed to delete thread:', err);
      useAiPanelStore.getState().setThreads(previousThreads);
      if (wasActive) useAiPanelStore.getState().setActiveThreadId(id);
    }
  };

  const handleBack = () => {
    useAiPanelStore.getState().setActiveThreadId(null);
    useAiPanelStore.getState().setMessages([]);
    useAiPanelStore.getState().setStreaming(false);
    useAiPanelStore.getState().setPendingQuestion(null);
  };

  const isAutomationPanel = fileAnchor?.language === 'automation' || fileAnchor?.path?.startsWith('automation:');
  const panelTitle = isAutomationPanel ? 'Automation AI' : fileAnchor ? 'File AI' : 'Session AI';

  return (
    <>
      {!isMobile && <ResizeHandle onResize={handlePanelResize} defaultWidth={AI_PANEL_DEFAULT_WIDTH} />}
      <div
        className={
          isMobile
            ? 'fixed inset-0 z-50 bg-surface-900 flex flex-col h-full'
            : 'border-l border-surface-800 bg-surface-900 flex flex-col h-full shrink-0'
        }
        style={isMobile ? undefined : { width: `${panelWidth}px` }}
      >
      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-800 shrink-0">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
          </svg>
          <span className="text-[15px] font-semibold text-gray-200">{panelTitle}</span>
        </div>
        <button
          onClick={() => useAiPanelStore.getState().setOpen(false)}
          className="p-1 hover:bg-surface-700 rounded transition-colors text-gray-500 hover:text-gray-300"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <span className="text-[14px] text-gray-500">Loading...</span>
          </div>
        ) : activeThreadId ? (
          <ThreadView onBack={handleBack} onFileClick={onFileClick} />
        ) : threads.length === 0 ? (
          <ThreadView onBack={handleBack} onEnsureThread={ensureThread} onFileClick={onFileClick} draft />
        ) : (
          <ThreadList
            onSelectThread={handleSelectThread}
            onNewThread={handleNewThread}
            onNewProjectThread={handleNewProjectThread}
            onDeleteThread={handleDeleteThread}
            canCreateProjectThread={!!activeSession?.projectId && activeSessionId === contextId}
          />
        )}
      </div>
      </div>
    </>
  );
}
