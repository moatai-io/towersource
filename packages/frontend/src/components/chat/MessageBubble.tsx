import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentIdentityAvatar } from '../../features/agent-profile/AgentIdentityAvatar';

const LIVE_TURN_TIMER_INTERVAL_MS = 500;
const UI_STATE_MAX_ENTRIES = 1_000;

function rememberUiState<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > UI_STATE_MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

const uiStateStore = {
  toolGroups: new Map<string, { expanded: boolean; activeToolId: string | null }>(),
  thinkingGroups: new Map<string, { activeThinkingKey: string | null }>(),
};
import { ToolUseCard, ToolChip } from './ToolUseCard';
import { getThinkingLabel, getToolActivityLabel, getToolActivityNoun } from '../../utils/message-parser';
import { ThinkingChip, ThinkingContent } from './ThinkingBlock';
import { SkillInvocationChip, type SkillInvocationMeta } from './SkillInvocationChip';
import { RichContent } from '../shared/RichContent';
// getToolLabel / getToolSummary used by ToolUseCard.tsx
import { toastError, toastQuiet } from '../../utils/toast';
import { useChatStore, type ChatMessage, type ContentBlock } from '../../stores/chat-store';
import { useSessionStore } from '../../stores/session-store';
import { useSettingsStore } from '../../stores/settings-store';
import { safeStr } from '../shared/parse-loose-json';
import { serverNowMs } from '../../utils/server-clock';
import { useActiveSessionStreaming } from '../../hooks/useActiveSessionStreaming';
import { useActiveSessionTurnState } from '../../hooks/useActiveSessionTurnState';
import { fileServeUrl, isPreviewableImageFilePath, splitFilePathsInText as splitTowerFilePathsInText } from '../../utils/file-path-links';
import { sessionAttachmentContentUrl, sessionAttachmentIdFromUri } from '../../utils/session-attachment-links';
import { RunIndicator } from '../common/RunIndicator';
import { AgentCard, AgentOriginBubble } from '../../features/agent-card/AgentCards';
import { isAgentOriginMessage, shouldHideAgentReportBubble } from '../../features/agent-card/agent-message-policy';
import { isAgentTool } from '../../features/agent-card/agent-card-model';
import { getCurrentUsername } from '../../utils/auth';
import { ConversationBranchAction } from './ConversationBranchAction';
import { cacheSessionMessages } from '../../utils/session-message-cache';

/* ── File tag rendering for user messages ── */

const FILE_TAG_REGEX = /\[file:\s*([^\]]+)\]/g;

function extractPdfExportPreviewPaths(resultText: string): string[] {
  if (!/Exported PDF artifact/i.test(resultText) && !/\[Final preview images\]/i.test(resultText)) return [];
  const paths = new Set<string>();
  const imagePathRegex = /(?:^|\s)(\/?(?:home|workspace)\/[^\n\r\]]+?\.(?:png|jpg|jpeg|webp)|~\/workspace\/[^\n\r\]]+?\.(?:png|jpg|jpeg|webp))/gi;
  for (const match of resultText.matchAll(imagePathRegex)) {
    paths.add(match[1].trim().replace(/[),.;]+$/, ''));
  }
  return [...paths];
}

function PdfExportPreview({ resultText, onFileClick }: { resultText: string; onFileClick?: (path: string) => void }) {
  const paths = extractPdfExportPreviewPaths(resultText);
  if (paths.length === 0) return null;
  return (
    <div className="mt-2 w-full max-w-[520px] md:max-w-[50%] space-y-2 rounded-xl border border-surface-700/50 bg-surface-900/60 p-3">
      <div className="flex items-center justify-between gap-2 text-sm text-gray-400">
        <span>PDF preview</span>
        <span>{paths.length} page{paths.length > 1 ? 's' : ''}</span>
      </div>
      <div className="space-y-3">
        {paths.map((path, index) => (
          <button
            key={`${path}-${index}`}
            type="button"
            onClick={() => onFileClick?.(path)}
            className="block w-full overflow-hidden rounded-lg border border-surface-700/60 bg-black/30 text-left transition-colors hover:border-primary-500/60"
            title={path}
          >
            <img
              src={fileServeUrl(path)}
              alt={`PDF preview page ${index + 1}`}
              className="block w-full max-h-[420px] object-contain bg-black/20"
              loading="lazy"
            />
            <span className="block truncate border-t border-surface-800/80 px-2 py-1.5 text-[13px] text-gray-500">
              {path}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ArtifactMarkdownCard({ block, onFileClick }: { block: ContentBlock; onFileClick?: (path: string) => void }) {
  const displayPath = block.portablePath || block.path || '';
  const saved = block.status === 'saved';
  if (!displayPath && !block.error) return null;

  if (saved && displayPath) {
    return (
      <div className="mt-2 min-w-0 max-w-full text-[13px] text-surface-400">
        <span className="text-surface-500">파일: </span>
        <button
          type="button"
          className="inline cursor-pointer break-all border-0 bg-transparent p-0 font-mono text-inherit underline decoration-current underline-offset-2 transition-opacity hover:opacity-80"
          onClick={(event) => {
            event.stopPropagation();
            onFileClick?.(displayPath);
          }}
          title={`Open ${displayPath}`}
          aria-label={`파일 열기: ${displayPath}`}
        >
          {displayPath}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 min-w-0 max-w-full overflow-hidden rounded-xl border p-3 text-[13px] tone-card tone-warning">
      <div className="min-w-0 max-w-full">
        <div className="font-semibold tone-text">파일 저장 실패</div>
        {displayPath && (
          <button
            type="button"
            onClick={() => onFileClick?.(displayPath)}
            className="mt-2 inline cursor-pointer break-all border-0 bg-transparent p-0 font-mono text-[12px] tone-text underline decoration-current underline-offset-2 opacity-80 transition-opacity hover:opacity-100"
            title={`Open ${displayPath}`}
            aria-label={`파일 열기: ${displayPath}`}
          >
            {displayPath}
          </button>
        )}
        {block.error && <div className="mt-2 text-[12px] tone-text opacity-75">{block.error}</div>}
      </div>
    </div>
  );
}

/** Render user message text, replacing [file: /path] with inline previews */
function renderBareUserFilePaths(text: string, onFileClick?: (path: string) => void, keyPrefix = 'bare'): React.ReactNode[] {
  if (!onFileClick) return [<React.Fragment key={`${keyPrefix}-raw`}>{text}</React.Fragment>];
  const linked = splitTowerFilePathsInText(text, onFileClick, (filePath, key) => (
    <button
      key={`${keyPrefix}-${key}`}
      type="button"
      className="inline cursor-pointer break-all border-0 bg-transparent p-0 font-inherit text-inherit underline decoration-current underline-offset-2 transition-opacity hover:opacity-80"
      onClick={(event) => {
        event.stopPropagation();
        onFileClick(filePath);
      }}
      title={`Open ${filePath}`}
      aria-label={`파일 열기: ${filePath}`}
    >
      {filePath}
    </button>
  ));
  return linked.length > 0 ? linked : [<React.Fragment key={`${keyPrefix}-raw`}>{text}</React.Fragment>];
}

function SessionAttachmentPreview({ uri, onFileClick }: { uri: string; onFileClick?: (path: string) => void }) {
  const sessionId = useChatStore.getState().sessionId || useSessionStore.getState().activeSessionId || '';
  const attachmentId = sessionAttachmentIdFromUri(uri);
  const token = localStorage.getItem('token');
  const contentUrl = sessionAttachmentContentUrl(sessionId, uri, token);
  const [metadata, setMetadata] = useState<{ name?: string; mimeType?: string | null } | null>(null);

  useEffect(() => {
    if (!sessionId || !attachmentId) return;
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    fetch(`/api/session-attachments/${encodeURIComponent(sessionId)}/${encodeURIComponent(attachmentId)}`, { headers })
      .then(async (response) => response.ok ? response.json() : null)
      .then((data) => setMetadata(data?.attachment || null))
      .catch(() => setMetadata(null));
  }, [attachmentId, sessionId]);

  const name = metadata?.name || '첨부파일';
  if (metadata?.mimeType?.startsWith('image/') && contentUrl) {
    return (
      <span className="block my-2">
        <img
          src={contentUrl}
          alt={name}
          className="max-w-full max-h-[300px] rounded-lg border border-surface-700/40 cursor-pointer hover:border-primary-500/50 transition-colors"
          loading="lazy"
          onClick={() => onFileClick?.(uri)}
        />
        <span className="text-[13px] text-gray-500 mt-1 block">{name}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      className="file-chip inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[14px] cursor-pointer transition-colors mx-0.5"
      onClick={() => onFileClick?.(uri)}
    >
      {name}
    </button>
  );
}

function renderUserText(text: string, onFileClick?: (path: string) => void): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  const regex = new RegExp(FILE_TAG_REGEX.source, 'g');

  for (const match of text.matchAll(regex)) {
    const fullMatch = match[0];
    const filePath = match[1].trim();
    const start = match.index!;

    // Text before this match
    if (start > lastIndex) {
      parts.push(...renderBareUserFilePaths(text.slice(lastIndex, start), onFileClick, `t-${lastIndex}`));
    }

    const fileName = filePath.split('/').pop() || filePath;
    // Strip timestamp prefix for display (e.g. "1776161802132-image.png" → "image.png")
    const displayName = fileName.replace(/^\d{10,}-/, '');

    if (sessionAttachmentIdFromUri(filePath)) {
      parts.push(<SessionAttachmentPreview key={`f-${start}`} uri={filePath} onFileClick={onFileClick} />);
    } else if (isPreviewableImageFilePath(filePath)) {
      // Image preview
      parts.push(
        <span key={`f-${start}`} className="block my-2">
          <img
            src={fileServeUrl(filePath)}
            alt={displayName}
            className="max-w-full max-h-[300px] rounded-lg border border-surface-700/40 cursor-pointer hover:border-primary-500/50 transition-colors"
            loading="lazy"
            onClick={() => onFileClick?.(filePath)}
          />
          <span className="text-[13px] text-gray-500 mt-1 block">{displayName}</span>
        </span>
      );
    } else {
      // File link chip
      parts.push(
        <span
          key={`f-${start}`}
          className="file-chip inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[14px] cursor-pointer transition-colors mx-0.5"
          onClick={() => onFileClick?.(filePath)}
        >
          <svg className="shrink-0 w-3.5 h-3.5 opacity-80" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M7.75 3.75h6.5L18.25 8v12.25H7.75z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M14 3.75V8h4.25" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 12h8M8 16h5" />
          </svg>
          {displayName}
        </span>
      );
    }

    lastIndex = start + fullMatch.length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    parts.push(...renderBareUserFilePaths(text.slice(lastIndex), onFileClick, `t-${lastIndex}`));
  }

  return parts.length > 0 ? parts : renderBareUserFilePaths(text, onFileClick);
}

/**
 * Copy button that writes both text/plain (raw markdown) and text/html (rendered)
 * to the clipboard. Rich editors (Google Docs, Notion, Slack) use the HTML;
 * plain editors (VS Code, terminal) use the markdown.
 */
function CopyButton({ text, contentRef, className = '' }: {
  text: string;
  contentRef?: React.RefObject<HTMLDivElement | null>;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      // Build HTML from rendered DOM content (if available), else from plain text
      let html = '';
      if (contentRef?.current) {
        html = extractRichHtml(contentRef.current);
      }
      if (!html) {
        // Fallback: simple markdown-to-HTML conversion for line breaks & paragraphs
        html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>');
        html = `<p>${html}</p>`;
      }

      const blob = new Blob([html], { type: 'text/html' });
      const textBlob = new Blob([text], { type: 'text/plain' });
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': blob,
          'text/plain': textBlob,
        }),
      ]);
    } catch {
      // Fallback for browsers that don't support ClipboardItem
      await navigator.clipboard.writeText(text);
    }
    toastQuiet('복사됨');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text, contentRef]);

  return (
    <button
      onClick={handleCopy}
      className={`flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-2.5 text-surface-500 transition-colors hover:bg-surface-800 hover:text-surface-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 sm:min-h-10 sm:min-w-10 md:min-w-fit md:shrink-0 ${className}`}
      title="복사"
      aria-label="메시지 복사"
    >
      {copied ? (
        <svg className="tone-success tone-text w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
      <span className="hidden whitespace-nowrap text-[12px] font-medium md:inline">복사</span>
    </button>
  );
}

function getMessageText(content: ContentBlock[]): string {
  return content
    .filter((b) => (b.type === 'text' || b.type === 'artifact_markdown') && b.text)
    .map((b) => b.text!)
    .join('\n');
}

function jsonHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

/**
 * 메시지 anchor 링크 복사 버튼 — Phase 3 (issue #11).
 * `/s/<sessionShortCode>#m-<messageShortId>` 형태의 절대 URL 을 clipboard 로.
 *
 * shortId 가 없는 메시지 (optimistic add 직후·backfill 직전) 는 *lazy fetch* —
 * 클릭 시 backend 에서 해당 세션 메시지 한 번 조회해 short_id 받아 chat-store 에
 * patch + clipboard 복사. 그러면 다른 미반영 메시지들도 동시에 갱신됨.
 *
 * 사용자에게는 *항상* 버튼이 보임 — UX 일관성. shortId 가 결국 없으면 토스트로 안내.
 */
function AnchorLinkButton({
  shortId,
  messageId,
  className = '',
}: {
  shortId?: string;
  messageId: string;
  className?: string;
}) {
  const sessionShortCode = useSessionStore((s) => {
    const active = s.sessions.find((ss) => ss.id === s.activeSessionId);
    return active?.shortCode || s.activeSessionId;
  });
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!sessionShortCode) {
      toastError('세션 정보를 찾을 수 없습니다');
      return;
    }
    let id = shortId;
    if (!id && activeSessionId) {
      // lazy fetch — store 의 messages 가 optimistic 상태라 short_id 미반영.
      // /sessions/:sid/messages 한 번 호출 → 응답에서 short_id 추출 후 store patch.
      try {
        const headers: Record<string, string> = {};
        const token = localStorage.getItem('token');
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(`/api/sessions/${activeSessionId}/messages?limit=500`, { headers });
        if (res.ok) {
          const payload = await res.json();
          const stored: Array<{ id: string; short_id?: string | null }> = Array.isArray(payload)
            ? payload
            : (payload.messages ?? []);
          const updates = stored
            .filter((m) => m.short_id)
            .map((m) => ({ id: m.id, shortId: m.short_id as string }));
          if (updates.length > 0) {
            useChatStore.getState().patchMessageShortIds(updates);
          }
          id = stored.find((m) => m.id === messageId)?.short_id || undefined;
        }
      } catch {
        // network error — fall through to fallback toast
      }
    }
    if (!id) {
      toastQuiet('아직 링크가 발급되지 않았습니다');
      return;
    }
    const path = window.location.pathname.startsWith('/shared/')
      ? window.location.pathname
      : `/s/${sessionShortCode}`;
    const url = `${window.location.origin}${path}#m-${id}`;
    try {
      await navigator.clipboard.writeText(url);
      toastQuiet('메시지 링크 복사됨');
    } catch {
      toastError('복사 실패 — 권한을 확인해주세요');
    }
  }, [shortId, messageId, sessionShortCode, activeSessionId]);

  if (!sessionShortCode) return null;

  return (
    <button
      onClick={handleClick}
      className={`flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-2.5 text-surface-500 transition-colors hover:bg-surface-800 hover:text-surface-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 sm:min-h-10 sm:min-w-10 md:min-w-fit md:shrink-0 ${className}`}
      title="링크"
      aria-label="메시지 링크 복사"
    >
      <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.9} d="M10.75 13.25l2.5-2.5" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.9} d="M8.5 11.75l-1.05 1.05a3 3 0 104.25 4.25l1.05-1.05" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.9} d="M15.5 12.25l1.05-1.05a3 3 0 10-4.25-4.25l-1.05 1.05" />
      </svg>
      <span className="hidden whitespace-nowrap text-[12px] font-medium md:inline">링크</span>
    </button>
  );
}

function formatMessageTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  const time = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (isToday) return time;
  if (isYesterday) return `어제 ${time}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

function formatCompletionTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

interface MessageBubbleProps {
  message: ChatMessage;
  assistantProject?: import('../../stores/project-store').Project | null;
  onOpenAssistantHome?: () => void;
  onFileClick?: (path: string) => void;
  onRetry?: (text: string) => void;
  onCancelQueued?: (messageId: string) => void;
  showMetrics?: boolean;
  isLastAssistant?: boolean;
  /** Render TodoWrite progress only for the current live assistant turn.
   *  Old snapshots are transcript noise once a newer assistant message exists. */
  showTodoSnapshots?: boolean;
  /** True when the previous message is from the same user — group tightly and
   *  hide the repeated name/time header. See GitHub issue #17. */
  isContinuation?: boolean;
}

/**
 * Compact divider chip for the engine-switch marker. Sits between turns
 * so the user can see "here is where we moved from Claude to Pi" without
 * the marker looking like a user message.
 *
 * Source: messages.metadata.engineSwitch (= {from, to, atTurn, at}) written
 * by services/session/engine-switch.ts.
 */
const ENGINE_LABEL: Record<string, string> = { claude: 'Claude', pi: 'Pi', local: 'Local' };
function engineLabel(e: string): string {
  return ENGINE_LABEL[e] ?? e;
}

function AssistantMark({ active = false, project, onOpenHome }: { active?: boolean; project?: import('../../stores/project-store').Project | null; onOpenHome?:()=>void }) {
  if (project) {
    const content=<AgentIdentityAvatar project={project} className="h-8 w-8 rounded-lg" fallbackClassName="h-8 w-8 rounded-lg"/>;
    return onOpenHome?<button type="button" onClick={onOpenHome} className="h-8 w-8 overflow-hidden rounded-lg border border-primary-400/20" title={`${project.agent?.displayName||project.name} 홈`} aria-label={`${project.agent?.displayName||project.name} 홈 열기`}>{content}</button>:<span className="h-8 w-8 overflow-hidden rounded-lg border border-primary-400/20">{content}</span>;
  }
  return (
    <span
      className={`tower-assistant-mark ${active ? 'tower-assistant-mark--active' : ''}`}
      title="Tower AI"
      aria-label="Tower AI"
    >
      {active ? (
        <svg className="tower-sequential-mark tower-sequential-mark--compact" viewBox="0 0 512 512" aria-hidden="true" focusable="false">
          <g className="tower-sequential-mark__layer tower-sequential-mark__layer--top">
            <path className="tower-sequential-mark__face-main" d="M256 50 L436 135 L256 220 L76 135Z"/>
          </g>
          <g className="tower-sequential-mark__layer tower-sequential-mark__layer--middle">
            <path className="tower-sequential-mark__face-side" d="M76 187 L256 272 L256 324 L76 239Z"/>
            <path className="tower-sequential-mark__face-main" d="M256 272 L436 187 L436 239 L256 324Z"/>
          </g>
          <g className="tower-sequential-mark__layer tower-sequential-mark__layer--bottom">
            <path className="tower-sequential-mark__face-side" d="M76 291 L256 376 L256 428 L76 343Z"/>
            <path className="tower-sequential-mark__face-main" d="M256 376 L436 291 L436 343 L256 428Z"/>
          </g>
        </svg>
      ) : (
        <svg className="tower-assistant-mark__icon tower-shaded-mark" viewBox="0 0 512 512" aria-hidden="true" focusable="false">
          <path className="tower-shaded-mark__face-top" d="M256 50 L436 135 L256 220 L76 135Z"/>
          <path className="tower-shaded-mark__face-side" d="M76 187 L256 272 L256 324 L76 239Z"/>
          <path className="tower-shaded-mark__face-main" d="M256 272 L436 187 L436 239 L256 324Z"/>
          <path className="tower-shaded-mark__face-side" d="M76 291 L256 376 L256 428 L76 343Z"/>
          <path className="tower-shaded-mark__face-main" d="M256 376 L436 291 L436 343 L256 428Z"/>
        </svg>
      )}
    </span>
  );
}

function EngineSwitchMarker({ from, to, at }: { from: string; to: string; at?: string }) {
  const time = at ? new Date(at) : null;
  const timeStr = time && !isNaN(time.getTime())
    ? time.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;
  return (
    <div className="flex items-center gap-3 py-5 px-2" data-testid="engine-switch-marker">
      <div className="flex-1 h-px bg-surface-700/50" />
      <div
        className="flex items-center gap-2 text-[13px] text-gray-500 select-none whitespace-nowrap"
        title={timeStr ? `엔진 전환됨 · ${timeStr}` : '엔진 전환됨'}
      >
        <span>🔀</span>
        <span className="px-1.5 py-0.5 rounded bg-surface-800 border border-surface-700/60 text-gray-400">
          {engineLabel(from)}
        </span>
        <svg className="w-3 h-3 text-surface-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
        </svg>
        <span className="px-1.5 py-0.5 rounded bg-primary-500/15 border border-primary-500/30 text-primary-300">
          {engineLabel(to)}
        </span>
      </div>
      <div className="flex-1 h-px bg-surface-700/50" />
    </div>
  );
}

export function MessageBubble({ message, assistantProject, onOpenAssistantHome, onFileClick, onRetry, onCancelQueued, showMetrics, isLastAssistant, showTodoSnapshots = true, isContinuation }: MessageBubbleProps) {
  const { t } = useTranslation('chat');
  const turnRewindEnabled = useSettingsStore((state) => state.serverConfig?.turnRewindEnabled === true);
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  // Parent ChatPanel owns the active-turn targeting. Do not re-check session-store
  // streaming here: it can briefly desync during tool/Todo updates or session
  // re-entry, which makes the active Tower icon stop animating mid-run.
  const isActiveAssistant = !isUser && !!isLastAssistant;

  // Engine hard-switch marker — backend stores it with role='user' + metadata.engineSwitch
  // (workspace/decisions/2026-05-19-engine-hard-switch-design.md §"핵심 원칙" #5).
  // Render as a compact divider chip, NOT a user bubble — it's a system note,
  // not the user's words. Matches the visual language of the 'compact-' marker
  // (just below) so engine-switch and context-compact read consistently.
  const engineSwitchMeta = (message.metadata as any)?.engineSwitch as
    | { from?: string; to?: string; atTurn?: number; at?: string }
    | undefined;
  const skillInvocationMeta = (message.metadata as any)?.skillInvocation as SkillInvocationMeta | undefined;
  if (engineSwitchMeta?.from && engineSwitchMeta?.to) {
    return <EngineSwitchMarker from={engineSwitchMeta.from} to={engineSwitchMeta.to} at={engineSwitchMeta.at} />;
  }

  if (shouldHideAgentReportBubble(message)) {
    return null;
  }

  if (isAgentOriginMessage(message)) {
    return <AgentOriginBubble message={message} onFileClick={onFileClick} />;
  }

  if (isSystem) {
    // Compact marker — keep it as a tiny, low-contrast note.
    // This is only a transcript boundary, not an event that needs attention.
    const isCompactMarker = message.id.startsWith('compact-');
    if (isCompactMarker) {
      return (
        <div
          className="flex justify-start py-1.5 px-2"
          aria-label="이전 대화 맥락이 압축됨"
          title="이전 대화 맥락이 압축됨"
        >
          <span className="text-[12px] leading-none text-gray-400/65 dark:text-gray-600 whitespace-nowrap select-none">
            AI의 작업 맥락이 길어져, 한번 정리하였습니다.
          </span>
        </div>
      );
    }
    return (
      <div className="flex justify-center py-3">
        <div className="bg-surface-900/60 border border-surface-700/40 text-gray-500 text-[15px] px-4 py-1.5 rounded-full max-w-lg">
          {message.content.map((b, i) => (
            <span key={i}>{safeStr(b.text)}</span>
          ))}
        </div>
      </div>
    );
  }

  const activeSessionId = useChatStore.getState().sessionId;
  const sessionOwnerUsername = activeSessionId
    ? useSessionStore.getState().sessions.find((s) => s.id === activeSessionId)?.ownerUsername || undefined
    : undefined;
  const displayUsername = isUser
    ? (
        message.username
        || (message.sendStatus && message.sendStatus !== 'delivered'
          ? (getCurrentUsername() || (typeof window !== 'undefined' ? localStorage.getItem('username') || undefined : undefined))
          : undefined)
        || sessionOwnerUsername
      )
    : undefined;

  // Group content blocks: consecutive tool_use blocks become a group
  const groups = useMemo(() => {
    const hasThinking = message.content.some((block) => block.type === 'thinking');
    if (!hasThinking && (message.reasoningTokens || 0) > 0) {
      return groupContentBlocks([
        { type: 'thinking', thinking: { text: '', title: getThinkingLabel() } },
        ...message.content,
      ]);
    }
    return groupContentBlocks(message.content);
  }, [message.content, message.reasoningTokens]);

  const originalUserText = useMemo(() => getMessageText(message.content), [message.content]);
  const canBranchUserMessage = message.sendStatus !== 'queued' && message.sendStatus !== 'failed';
  const [editingUserMessage, setEditingUserMessage] = useState(false);
  const [editText, setEditText] = useState(originalUserText);
  const [editState, setEditState] = useState<'idle' | 'sending' | 'error'>('idle');
  const [editError, setEditError] = useState('');
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const userContentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!editingUserMessage) return;
    window.requestAnimationFrame(() => {
      const textarea = editTextareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  }, [editingUserMessage]);

  const beginInlineEdit = useCallback(() => {
    setEditText(originalUserText);
    setEditError('');
    setEditState('idle');
    setEditingUserMessage(true);
  }, [originalUserText]);

  const cancelInlineEdit = useCallback(() => {
    setEditingUserMessage(false);
    setEditText(originalUserText);
    setEditError('');
    setEditState('idle');
  }, [originalUserText]);

  const submitInlineEdit = useCallback(async (mode: 'edit_and_resend' | 'clone_through') => {
    const editedPrompt = editText.trim();
    if ((mode === 'edit_and_resend' && !editedPrompt) || !activeSessionId || editState === 'sending') return;
    setEditState('sending');
    setEditError('');
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}/messages/${encodeURIComponent(message.id)}/branch`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ mode }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || '새 대화를 만들지 못했습니다.');
      const session = body.session;
      if (!session?.id) throw new Error('새 대화 정보를 찾지 못했습니다.');
      localStorage.removeItem(`tower:inputDraft:${session.id}`);
      useSessionStore.getState().addSession(session);
      window.dispatchEvent(new CustomEvent('kanban-select-session', { detail: { sessionId: session.id } }));
      const prompt = mode === 'edit_and_resend' ? editedPrompt : body.replayPrompt;
      if (prompt) {
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('tower-replay-branch-prompt', {
          detail: { sessionId: session.id, prompt, cwd: session.cwd },
        })), 250);
      }
      setEditingUserMessage(false);
      setEditState('idle');
    } catch (err) {
      setEditError(err instanceof Error ? err.message : '새 대화를 만들지 못했습니다.');
      setEditState('error');
    }
  }, [activeSessionId, editState, editText, message.id]);

  const submitInlineResendCurrent = useCallback(async () => {
    const editedPrompt = editText.trim();
    if (!editedPrompt || !activeSessionId || editState === 'sending') return;
    setEditState('sending');
    setEditError('');
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}/messages/${encodeURIComponent(message.id)}/rewind-replay`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || '대화를 되감지 못했습니다.');
      const currentMessages = useChatStore.getState().messages;
      const index = currentMessages.findIndex((item) => item.id === message.id);
      if (index >= 0) {
        const prefixMessages = currentMessages.slice(0, index);
        useChatStore.getState().setMessages(prefixMessages);
        cacheSessionMessages(activeSessionId, prefixMessages);
      }
      window.dispatchEvent(new CustomEvent('tower-replay-branch-prompt', {
        detail: { sessionId: activeSessionId, prompt: editedPrompt, cwd: body.session?.cwd },
      }));
      setEditingUserMessage(false);
      setEditState('idle');
    } catch (err) {
      setEditError(err instanceof Error ? err.message : '대화를 되감지 못했습니다.');
      setEditState('error');
    }
  }, [activeSessionId, editState, editText, message.id]);

  const messageRowClass = isUser
    ? `flex min-w-0 max-w-full gap-3 ${isContinuation ? 'pt-0.5 pb-0.5' : 'py-5'} justify-end group/message`
    : `flex min-w-0 max-w-full flex-col md:flex-row gap-1 md:gap-3 ${isContinuation ? 'pt-0.5 pb-0.5' : 'py-5'} justify-start group/message`;
  const messageBodyClass = isUser
    ? 'min-w-0 max-w-[88%] overflow-visible order-first'
    : 'min-w-0 w-full max-w-full overflow-hidden md:flex-1';

  return (
    <div
      id={message.shortId ? `m-${message.shortId}` : undefined}
      data-message-id={message.id}
      className={messageRowClass}
    >
      {!isUser && (
        <div className="flex flex-row md:flex-col items-center gap-2 md:gap-1 shrink-0 mt-0.5 mb-1 md:mb-0">
          <AssistantMark active={isActiveAssistant} project={assistantProject} onOpenHome={onOpenAssistantHome} />
          {message.timestamp && (
            <span className="text-[12px] text-gray-600 select-none whitespace-nowrap">{formatMessageTime(message.timestamp)}</span>
          )}
        </div>
      )}

      <div className={messageBodyClass}>
        {isUser ? (
          <div>
            {/* Speaker + timestamp meta line. Keep speaker visible but quiet even for
                grouped consecutive user messages; hide only the repeated timestamp. */}
            {(displayUsername || (!isContinuation && message.timestamp)) && (
              <div className="flex items-center justify-end gap-1.5 mb-1 px-1 text-[13px] leading-none text-gray-400">
                {displayUsername && (
                  <span
                    className="font-medium"
                    title={`발화자: ${displayUsername}`}
                  >
                    {displayUsername}
                  </span>
                )}
                {!isContinuation && message.timestamp && (
                  <span className="text-[13px] text-gray-500">{formatMessageTime(message.timestamp)}</span>
                )}
              </div>
            )}
            {editingUserMessage ? (
              <div className="chat-user-bubble rounded-2xl rounded-tr-sm p-3 text-msg-size leading-relaxed">
                <label className="mb-2 block text-[13px] font-medium text-surface-300">요청 수정</label>
                <textarea
                  ref={editTextareaRef}
                  value={editText}
                  onChange={(event) => setEditText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelInlineEdit();
                    }
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                      event.preventDefault();
                      void submitInlineEdit('edit_and_resend');
                    }
                  }}
                  className="min-h-28 w-full resize-y rounded-xl border border-surface-700 bg-surface-950/20 px-3 py-2 text-msg-size leading-relaxed text-surface-100 outline-none transition-colors placeholder:text-surface-500 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/30"
                  aria-label="수정할 요청 내용"
                />
                {editError && <p className="tone-danger tone-text mt-2 text-[13px]" role="alert">{editError}</p>}
                <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    onClick={cancelInlineEdit}
                    disabled={editState === 'sending'}
                    aria-label="취소"
                    title="취소"
                    className="min-h-11 w-full rounded-lg border border-surface-700 px-3 text-[18px] leading-none text-surface-300 transition-colors hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 sm:min-h-10 sm:w-11 sm:px-0"
                  >
                    ×
                  </button>
                  <button
                    type="button"
                    onClick={() => void submitInlineResendCurrent()}
                    disabled={editState === 'sending' || editText.trim().length === 0}
                    className="min-h-11 w-full rounded-lg border border-surface-700 px-3 text-[13px] font-medium text-surface-300 transition-colors hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50 sm:min-h-10 sm:w-auto"
                  >
                    다시 보내기
                  </button>
                  <button
                    type="button"
                    onClick={() => void submitInlineEdit('edit_and_resend')}
                    disabled={editState === 'sending' || editText.trim().length === 0}
                    className="tone-accent tone-action min-h-11 w-full rounded-lg px-3 text-[13px] font-semibold disabled:opacity-50 sm:min-h-10 sm:w-auto"
                  >
                    {editState === 'sending' ? '처리 중…' : '새 대화에서 보내기'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="relative">
                <div ref={userContentRef} className={`relative chat-user-bubble rounded-2xl rounded-tr-sm px-4 py-3 text-msg-size leading-relaxed whitespace-pre-wrap ${
                  message.sendStatus === 'failed'
                    ? 'chat-user-bubble--failed ring-1 ring-red-500/25'
                    : message.sendStatus === 'queued'
                      ? 'chat-user-bubble--queued'
                      : ''
                }`}>
                  {message.content.map((block, i) => (
                    <span key={i}>{renderUserText(safeStr(block.text), onFileClick)}</span>
                  ))}
                </div>
                <div className="relative mt-1 flex min-h-11 items-center justify-end gap-1 opacity-100 transition-opacity md:absolute md:right-0 md:top-full md:z-10 md:mt-1 md:min-h-10 md:opacity-0 md:pointer-events-none md:group-hover/message:pointer-events-auto md:group-hover/message:opacity-100 md:group-focus-within/message:pointer-events-auto md:group-focus-within/message:opacity-100" aria-label="메시지 작업">
                  {turnRewindEnabled && activeSessionId && canBranchUserMessage && (
                    <ConversationBranchAction sessionId={activeSessionId} messageId={message.id} onEditRequested={beginInlineEdit} />
                  )}
                  <AnchorLinkButton shortId={message.shortId} messageId={message.id} />
                  <CopyButton text={getMessageText(message.content)} contentRef={userContentRef} />
                </div>
              </div>
            )}
            <SkillInvocationChip meta={skillInvocationMeta} align="right" />
            {message.sendStatus === 'queued' && (
              <div className="chat-queued-status flex items-center gap-2 mt-1.5 text-[14px] flex-wrap">
                <div className="chat-queued-spinner w-3 h-3 border-2 rounded-full animate-spin" />
                <span>대기 중 · 현재 턴이 끝나면 자동 전송됩니다</span>
                {onCancelQueued && (
                  <button
                    onClick={() => onCancelQueued(message.id)}
                    className="text-current hover:text-primary-300 underline underline-offset-2 transition-colors"
                  >
                    취소
                  </button>
                )}
              </div>
            )}
            {message.sendStatus === 'failed' && (
              <div className="flex items-center gap-2 mt-1.5 text-[14px] text-red-400/80 flex-wrap">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <span>전송 실패</span>
                {onRetry && (
                  <button
                    onClick={() => {
                      const text = useChatStore.getState().retryMessage(message.id);
                      if (text) onRetry(text);
                    }}
                    className="text-primary-400 hover:text-primary-300 underline underline-offset-2 transition-colors"
                  >
                    다시 시도
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <>
            <SkillInvocationChip meta={skillInvocationMeta} align="left" />
            <MessageBody
              groups={groups}
              message={message}
              onFileClick={onFileClick}
              isLastAssistant={isLastAssistant}
              showMetrics={showMetrics}
              showTodoSnapshots={showTodoSnapshots}
            />
          </>
        )}
      </div>

      {isUser && (
        isContinuation ? (
          // Keep the column width so grouped bubbles stay right-aligned, but
          // drop the repeated avatar (issue #17).
          <div className="w-7 shrink-0" aria-hidden />
        ) : (
          <div className="w-7 h-7 rounded-full bg-surface-850 flex items-center justify-center text-[11px] font-bold shrink-0 mt-5 ring-1 ring-surface-700/40 text-surface-300 select-none" title={message.username || 'User'}>
            {(message.username || 'U').charAt(0).toUpperCase()}
          </div>
        )
      )}
    </div>
  );
}

function ToolChipGroup({ blocks, onFileClick, stateKey, isLive = false }: { blocks: ContentBlock[]; onFileClick?: (path: string) => void; stateKey: string; isLive?: boolean }) {
  const { t } = useTranslation('chat');
  const isStreaming = useActiveSessionStreaming();
  // Filter out blocks without valid toolUse data
  const validBlocks = blocks.filter((b) => b.toolUse?.name);
  const immediatelyVisibleBlock = validBlocks.find((block) => {
    const kind = (block.toolUse!.name.split('.').pop() || block.toolUse!.name).replace(/^functions__/, '').toLowerCase();
    // AUQ history renders independently below; only secure input should force
    // the surrounding generic tool group open.
    return kind === 'credential_vault_input';
  });
  const storedToolState = uiStateStore.toolGroups.get(stateKey);
  const initialToolState = storedToolState || {
    expanded: !!immediatelyVisibleBlock,
    activeToolId: immediatelyVisibleBlock?.toolUse?.id ?? null,
  };
  const [expanded, setExpanded] = useState(initialToolState.expanded);
  const [activeToolId, setActiveToolId] = useState<string | null>(initialToolState.activeToolId);

  useEffect(() => {
    rememberUiState(uiStateStore.toolGroups, stateKey, { expanded, activeToolId });
  }, [stateKey, expanded, activeToolId]);

  if (validBlocks.length === 0) return null;

  const auqBlocks = validBlocks.filter((block) => {
    const name = block.toolUse!.name;
    return (name.split('.').pop() || name).replace(/^functions__/, '').toLowerCase() === 'askuserquestion';
  });
  const nonAuqBlocks = validBlocks.filter(block => !auqBlocks.includes(block));
  const auqHistoryRows = auqBlocks.map((block, index) => (
    <ToolUseCard
      key={`auq-${block.toolUse!.id || index}`}
      toolUseId={block.toolUse!.id}
      name={block.toolUse!.name}
      input={block.toolUse!.input}
      result={block.toolUse!.result}
      onFileClick={onFileClick}
      compact={true}
      defaultExpanded={true}
      isLive={isLive}
    />
  ));
  if (nonAuqBlocks.length === 0) {
    return auqHistoryRows.some(row => !!row) ? <div className="space-y-1">{auqHistoryRows}</div> : null;
  }

  const total = nonAuqBlocks.length;
  const completed = nonAuqBlocks.filter((b) => b.toolUse!.result).length;
  const running = !!isLive && isStreaming && completed < total;

  // Build user-facing activity summary (e.g. "정보 찾기 ×3, 파일 수정 ×1")
  const typeCounts = nonAuqBlocks.reduce<Record<string, number>>((acc, b) => {
    const label = getToolActivityNoun(b.toolUse!.name, b.toolUse!.input);
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});
  const typeLabels = Object.entries(typeCounts).map(([label, count]) =>
    count > 1 ? `${label} ×${count}` : label
  );

  // Find last tool activity for streaming display
  const lastBlock = nonAuqBlocks[nonAuqBlocks.length - 1];
  const lastTool = lastBlock?.toolUse;
  const lastToolSummary = lastTool ? getToolActivityLabel(lastTool.name, lastTool.input) : '';

  // Collapsed summary bar — unified with AgentCard line-2 style
  if (!expanded) {
    const collapsedToolGroup = (
      <button
        onClick={() => setExpanded(true)}
        data-tool-text={`${t('toolActivity.toolUseCount', { count: total })}: ${typeLabels.join(', ')}`}
        className="group/tool-bar inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-surface-700/30 bg-surface-800/20 hover:bg-surface-800/40 hover:border-surface-600/40 transition-all duration-150 cursor-pointer max-w-full align-middle"
      >
        {/* Wrench icon */}
        <svg className="w-3.5 h-3.5 text-surface-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
        </svg>

        {/* Count + separator + context — matches AgentCard line-2 format */}
        <span className="text-[12px] text-surface-500 tabular-nums shrink-0">{t('toolActivity.toolUseCount', { count: total })}</span>
        <span className="text-surface-700 text-[12px]">·</span>

        {/* Streaming: show last active tool / Done: show type summary */}
        {running ? (
          <span className="flex items-center gap-1 min-w-0">
            <RunIndicator size="xs" label="" className="shrink-0 text-primary-400/70" />
            <span className="text-[12px] text-surface-400 truncate">{lastToolSummary}</span>
          </span>
        ) : (
          <span className="text-[12px] text-surface-500 truncate">{typeLabels.join(', ')}</span>
        )}

        {/* All done check */}
        {!running && completed === total && (
          <svg className="tone-success tone-text w-3 h-3 opacity-50 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        )}

        {/* Expand arrow */}
        <svg className="w-3 h-3 text-surface-600 group-hover/tool-bar:text-surface-500 transition-colors shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
    );
    if (auqHistoryRows.length === 0) return collapsedToolGroup;
    return <div className="space-y-1">{auqHistoryRows}{collapsedToolGroup}</div>;
  }

  // Expanded: chip row + detail card
  const toolGroup = (
    <div className="rounded-lg border border-surface-700/30 bg-surface-800/10 overflow-hidden">
      {/* Header bar — click to collapse */}
      <button
        onClick={() => { setExpanded(false); setActiveToolId(null); }}
        className="group/tool-bar flex items-center gap-2 px-3 py-1.5 w-full hover:bg-surface-800/30 transition-colors"
      >
        <svg className="w-3.5 h-3.5 text-gray-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
        </svg>
        <span className="text-[13px] font-semibold text-gray-400 tabular-nums">{total}</span>
        <span className="text-[13px] text-gray-500 truncate flex-1 text-left">{typeLabels.join(', ')}</span>
        <svg className="w-3 h-3 text-gray-500 rotate-180 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Chip row */}
      <div className="px-3 pb-2 pt-1 flex flex-wrap gap-1.5 max-md:flex-nowrap max-md:overflow-x-auto max-md:pb-2">
        {nonAuqBlocks.map((block, i) => (
          <ToolChip
            key={i}
            toolUseId={block.toolUse!.id}
            name={block.toolUse!.name}
            input={block.toolUse!.input}
            result={block.toolUse!.result}
            isActive={activeToolId === block.toolUse!.id}
            isLive={isLive}
            isLast={i === nonAuqBlocks.length - 1}
            onClick={() => setActiveToolId(activeToolId === block.toolUse!.id ? null : block.toolUse!.id)}
          />
        ))}
      </div>

      {/* Expanded detail card below */}
      {activeToolId !== null && nonAuqBlocks.find((b) => b.toolUse!.id === activeToolId) && (() => {
        const activeBlock = nonAuqBlocks.find((b) => b.toolUse!.id === activeToolId)!;
        return (
          <div className="px-3 pb-3">
            <ToolUseCard
              toolUseId={activeBlock.toolUse!.id}
              name={activeBlock.toolUse!.name}
              input={activeBlock.toolUse!.input}
              result={activeBlock.toolUse!.result}
              onFileClick={onFileClick}
              defaultExpanded={true}
              isLive={isLive}
            />
          </div>
        );
      })()}
    </div>
  );

  if (auqHistoryRows.length === 0) return toolGroup;
  return <div className="space-y-1">{auqHistoryRows}{toolGroup}</div>;
}

function ThinkingChipGroup({ blocks, inlineToolBlocks, onFileClick, stateKey, isLive = false }: {
  blocks: ContentBlock[];
  inlineToolBlocks?: ContentBlock[];
  onFileClick?: (path: string) => void;
  stateKey: string;
  isLive?: boolean;
}) {
  useEffect(() => {
    rememberUiState(uiStateStore.thinkingGroups, stateKey, { activeThinkingKey: null });
  }, [stateKey]);

  const visibleThinkingBlocks = blocks.filter((block) => {
    if (isLive) return true;
    const text = (block.thinking?.text || '').trim();
    const title = (block.thinking?.title || '').trim();
    if (text.length > 0) return true;
    // Empty generic thinking placeholders are only useful while the turn is live.
    return title.length > 0 && title !== '생각 중' && title !== 'Thinking';
  });

  if (visibleThinkingBlocks.length === 0 && (!inlineToolBlocks || inlineToolBlocks.length === 0)) {
    return null;
  }

  return (
    <div>
      <div className="flex flex-wrap items-start gap-1.5">
        {visibleThinkingBlocks.map((block, i) => {
          const thinkingKey = `${block.thinking?.title || 'thinking'}:${i}`;
          return (
            <ThinkingChip
              key={thinkingKey}
              text={block.thinking?.text || ''}
              title={block.thinking?.title}
              isActive={false}
              isLive={isLive}
              onClick={() => {}}
            />
          );
        })}
        {inlineToolBlocks && inlineToolBlocks.length > 0 && (
          <ToolChipGroup blocks={inlineToolBlocks} onFileClick={onFileClick} stateKey={`${stateKey}:tools`} isLive={isLive} />
        )}
      </div>
    </div>
  );
}

/* ── TodoWrite Inline Card ── */

interface TodoInlineItem {
  content: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
}

function TodoInlineCard({ input, isLive, collapsed }: { input: Record<string, any>; isLive?: boolean; collapsed?: boolean }) {
  const isStreaming = useActiveSessionStreaming();
  const activeTurn = useActiveSessionTurnState();
  const todos: TodoInlineItem[] = Array.isArray(input.todos) ? input.todos : [];
  if (todos.length === 0) return null;

  const total = todos.length;
  const completed = todos.filter(t => t.status === 'completed').length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const allDone = completed === total;
  const hasActiveTodo = todos.some((todo) => todo.status === 'in_progress');
  // Only the current live TodoWrite card may react to global stream/turn state.
  // Older completed/cancelled assistant messages can still contain an `in_progress`
  // todo snapshot; without the `isLive` gate they would all animate/update when a
  // new turn starts elsewhere in the session.
  const isCurrentLiveCard = !!isLive;
  const showLive = isCurrentLiveCard && !allDone && hasActiveTodo && (activeTurn.phase === 'tool_running' || activeTurn.phase === 'streaming' || isStreaming);

  const cardTone = allDone ? 'tone-success' : showLive ? 'tone-accent' : 'tone-muted';
  const cardClassName = `tone-card ${cardTone} rounded-xl p-3 space-y-2`;

  const header = (
    <div className="flex items-center gap-2">
      <svg className={`w-4 h-4 ${cardTone} tone-text`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
      <span className={`text-[13px] font-semibold ${cardTone} tone-text opacity-85`}>진행 단계</span>
      <span className={`text-[12px] font-mono tabular-nums ${cardTone} tone-text opacity-65`}>
        {completed}/{total}
      </span>
    </div>
  );

  const progressBar = (
    <div className="h-1 bg-surface-800/60 rounded-full overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-500 ease-out"
        style={{
          width: `${pct}%`,
          background: allDone || showLive
            ? 'linear-gradient(90deg, var(--tone-text), color-mix(in srgb, var(--tone-text) 70%, white))'
            : '#6b7280',
        }}
      />
    </div>
  );

  const items = (
    <div className="space-y-0.5">
      {todos.map((todo, i) => (
        <div
          key={i}
          className={`flex items-start gap-2 px-1.5 py-1 rounded-md transition-colors ${
            showLive && todo.status === 'in_progress' ? 'tone-accent tone-bg-soft' : ''
          }`}
        >
          {todo.status === 'completed' ? (
            <svg className="w-3.5 h-3.5 tone-success tone-text shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
          ) : todo.status === 'in_progress' && showLive ? (
            <div className="w-3.5 h-3.5 shrink-0 mt-0.5 flex items-center justify-center">
              <div className="w-3 h-3 border-[1.5px] tone-accent tone-border border-t-current rounded-full animate-spin" />
            </div>
          ) : (
            <div className="w-3.5 h-3.5 shrink-0 mt-0.5 flex items-center justify-center">
              <div className={`w-2.5 h-2.5 rounded-full border-[1.5px] ${
                todo.status === 'in_progress' ? 'border-gray-500 bg-gray-500/20' : 'border-gray-600'
              }`} />
            </div>
          )}
          <span className={`text-[14px] leading-relaxed ${
            todo.status === 'completed'
              ? 'text-gray-500 line-through'
              : todo.status === 'in_progress' && showLive
                ? 'tone-accent tone-text font-medium'
                : todo.status === 'in_progress'
                  ? 'text-gray-400'
                  : 'text-gray-500'
          }`}>
            {todo.status === 'in_progress' && showLive && todo.activeForm
              ? safeStr(todo.activeForm)
              : safeStr(todo.content || (todo as any).title)}
          </span>
        </div>
      ))}
    </div>
  );

  if (collapsed) {
    return (
      <details className={cardClassName}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[14px] text-gray-500 marker:hidden">
          <span className="flex items-center gap-2">
            {header}
            <span>이전 진행 단계</span>
          </span>
          <span className="text-[13px] tabular-nums text-gray-600">{pct}%</span>
        </summary>
        <div className="mt-2 space-y-2">
          {progressBar}
          {items}
        </div>
      </details>
    );
  }

  return (
    <div className={cardClassName}>
      {header}
      {progressBar}
      {items}
    </div>
  );
}

/* ── MessageBody — clipboard-aware wrapper with inline tool chips ── */

function MessageBody({ groups, message, onFileClick, isLastAssistant, showMetrics, showTodoSnapshots }: {
  groups: BlockGroup[];
  message: ChatMessage;
  onFileClick?: (path: string) => void;
  isLastAssistant?: boolean;
  showMetrics?: boolean;
  showTodoSnapshots?: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Clipboard handler: on copy, produce clean text-only version
  const handleCopy = useCallback((e: ClipboardEvent) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;

    // Get selected range
    const range = sel.getRangeAt(0);
    if (!bodyRef.current?.contains(range.commonAncestorContainer)) return;

    // Build clean text + rich HTML from the selection
    const fragment = range.cloneContents();
    const cleanText = extractCleanText(fragment);
    if (cleanText) {
      e.clipboardData?.setData('text/plain', cleanText);

      // Build rich HTML from the actual rendered DOM selection
      const tempDiv = document.createElement('div');
      tempDiv.appendChild(fragment.cloneNode(true));
      // Remove tool/agent UI elements from the HTML copy
      tempDiv.querySelectorAll('[data-tool-text], [data-agent-text], button, svg').forEach(n => n.remove());
      const richHtml = tempDiv.innerHTML;
      e.clipboardData?.setData('text/html', richHtml || `<div>${cleanText.replace(/\n/g, '<br>')}</div>`);
      e.preventDefault();
    }
  }, []);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.addEventListener('copy', handleCopy);
    return () => el.removeEventListener('copy', handleCopy);
  }, [handleCopy]);

  let latestTodoGroupIndex = -1;
  let latestTodoBlockIndex = -1;
  let latestTodoAllDone = false;
  groups.forEach((group, groupIndex) => {
    group.blocks.forEach((block, blockIndex) => {
      if (block.toolUse?.name === 'TodoWrite') {
        latestTodoGroupIndex = groupIndex;
        latestTodoBlockIndex = blockIndex;
        const todos = Array.isArray(block.toolUse.input?.todos) ? block.toolUse.input.todos : [];
        latestTodoAllDone = todos.length > 0 && todos.every((todo: any) => todo.status === 'completed');
      }
    });
  });

  return (
    <div ref={bodyRef} className="relative min-w-0 max-w-full space-y-2">
      {groups.flatMap((group, gi) => {
        const previousGroup = groups[gi - 1];
        const nextGroup = groups[gi + 1];

        // Tool use blocks already rendered inline with the preceding thinking group
        if (group.type === 'tool_use' && previousGroup?.type === 'thinking') {
          return [];
        }

        // Tool use blocks — split into agents, todos, and regular tools
        if (group.type === 'tool_use') {
          const agentBlocks = group.blocks.filter(b => isAgentTool(b.toolUse?.name));
          const todoBlocks = !showTodoSnapshots || latestTodoAllDone
            ? []
            : group.blocks
              .map((block, blockIndex) => ({ block, blockIndex }))
              .filter(({ block, blockIndex }) => (
                block.toolUse?.name === 'TodoWrite'
                && gi === latestTodoGroupIndex
                && blockIndex === latestTodoBlockIndex
              ));
          const regularBlocks = group.blocks.filter(b => !isAgentTool(b.toolUse?.name) && b.toolUse?.name !== 'TodoWrite');
          return [
            <React.Fragment key={gi}>
              {/* Regular tools — inline collapsible bar */}
              {regularBlocks.length > 0 && (
                <ToolChipGroup blocks={regularBlocks} onFileClick={onFileClick} stateKey={`${message.id}:tool-group:${gi}`} isLive={!!isLastAssistant} />
              )}
              {/* Agent cards — grouped under a single left accent border */}
              {agentBlocks.length > 0 && (
                <div className="space-y-1">
                  {agentBlocks.map((block, ai) => (
                    <AgentCard key={`agent-${gi}-${ai}`} block={block} messageTimestamp={message.timestamp} />
                  ))}
                </div>
              )}
              {/* TodoWrite — inline checklist */}
              {todoBlocks.map(({ block, blockIndex }, ti) => {
                const isLatestTodo = gi === latestTodoGroupIndex && blockIndex === latestTodoBlockIndex;
                return (
                  <TodoInlineCard
                    key={`todo-${gi}-${ti}`}
                    input={block.toolUse!.input}
                    isLive={!!isLastAssistant && isLatestTodo}
                    collapsed={!isLatestTodo}
                  />
                );
              })}
            </React.Fragment>,
          ];
        }

        // Thinking — show title chip and keep adjacent regular tools on the same line
        if (group.type === 'thinking') {
          const inlineToolGroup = nextGroup?.type === 'tool_use' ? nextGroup : null;
          const inlineToolGroupIndex = inlineToolGroup ? gi + 1 : gi;
          const inlineRegularBlocks = inlineToolGroup
            ? inlineToolGroup.blocks.filter(b => !isAgentTool(b.toolUse?.name) && b.toolUse?.name !== 'TodoWrite')
            : [];
          const inlineAgentBlocks = inlineToolGroup
            ? inlineToolGroup.blocks.filter(b => isAgentTool(b.toolUse?.name))
            : [];
          const inlineTodoBlocks = inlineToolGroup && showTodoSnapshots && !latestTodoAllDone
            ? inlineToolGroup.blocks
              .map((block, blockIndex) => ({ block, blockIndex }))
              .filter(({ block, blockIndex }) => (
                block.toolUse?.name === 'TodoWrite'
                && inlineToolGroupIndex === latestTodoGroupIndex
                && blockIndex === latestTodoBlockIndex
              ))
            : [];

          return [
            <React.Fragment key={gi}>
              <ThinkingChipGroup
                blocks={group.blocks}
                inlineToolBlocks={inlineRegularBlocks}
                onFileClick={onFileClick}
                stateKey={`${message.id}:thinking-group:${gi}`}
                isLive={!!isLastAssistant}
              />
              {inlineAgentBlocks.length > 0 && (
                <div className="space-y-1">
                  {inlineAgentBlocks.map((block, ai) => (
                    <AgentCard key={`agent-inline-${gi}-${ai}`} block={block} messageTimestamp={message.timestamp} />
                  ))}
                </div>
              )}
              {inlineTodoBlocks.map(({ block, blockIndex }, ti) => {
                const isLatestTodo = inlineToolGroupIndex === latestTodoGroupIndex && blockIndex === latestTodoBlockIndex;
                return (
                  <TodoInlineCard
                    key={`todo-inline-${gi}-${ti}`}
                    input={block.toolUse!.input}
                    isLive={!!isLastAssistant && isLatestTodo}
                    collapsed={!isLatestTodo}
                  />
                );
              })}
            </React.Fragment>,
          ];
        }

        // Text — render with RichContent
        if (group.type === 'text') {
          return group.blocks.map((block, bi) => {
            if (!block.text) return null;
            return (
              <RichContent
                key={`${gi}-${bi}`}
                text={block.text}
                onFileClick={onFileClick}
              />
            );
          });
        }

        // Artifact-backed Markdown — render the same body in chat and show the
        // file pointer saved by the backend. The model generated this content
        // once; Tower derived the workspace file from this block.
        if (group.type === 'artifact_markdown') {
          return group.blocks.map((block, bi) => (
            <div key={`${gi}-${bi}`} className="min-w-0 max-w-full space-y-2 overflow-hidden">
              {block.text && <RichContent text={block.text} onFileClick={onFileClick} />}
              <ArtifactMarkdownCard block={block} onFileClick={onFileClick} />
            </div>
          ));
        }

        // Commentary is Codex/Responses preamble text. When classified as
        // user-visible progress, render it like ordinary assistant prose; it
        // remains a separate block type only so model rehydration/cache can
        // exclude it from future input.
        if (group.type === 'commentary') {
          return group.blocks.map((block, bi) => (
            block.visibility === 'progress' && block.text
              ? <RichContent key={`${gi}-${bi}`} text={block.text} onFileClick={onFileClick} />
              : null
          ));
        }

        // Tool results — minimal inline display, with rich PDF export previews when available.
        if (group.type === 'tool_result') {
          return [
            <div key={gi} className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {group.blocks.map((block, bi) => {
                  const resultText = block.toolUse?.result;
                  if (!resultText) return null;
                  return (
                    <span
                      key={bi}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface-800/50 border border-surface-700/30 text-[13px] text-gray-500 max-w-[300px] truncate"
                    >
                      <svg className="tone-success tone-text w-3 h-3 opacity-50 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Result
                    </span>
                  );
                })}
              </div>
              {group.blocks.map((block, bi) => {
                const resultText = block.toolUse?.result;
                if (!resultText) return null;
                return <PdfExportPreview key={`pdf-preview-${bi}`} resultText={resultText} onFileClick={onFileClick} />;
              })}
            </div>,
          ];
        }

        console.warn('[MessageBubble] unknown block group type:', group.type);
        return [];
      })}
      {showMetrics && <TurnMetricsBar message={message} isLast={!!isLastAssistant} />}
      <div
        className="flex min-h-11 items-center justify-end gap-1 opacity-100 transition-opacity md:min-h-10 md:pointer-events-none md:opacity-0 md:group-hover/message:pointer-events-auto md:group-hover/message:opacity-100 md:group-focus-within/message:pointer-events-auto md:group-focus-within/message:opacity-100"
        aria-label="AI 메시지 작업"
        data-testid="assistant-message-actions"
      >
        <AnchorLinkButton shortId={message.shortId} messageId={message.id} />
        <CopyButton text={getMessageText(message.content)} contentRef={bodyRef} />
      </div>
    </div>
  );
}

/** Check if a tool name is an agent/subagent tool */
/**
 * Extract clean rich HTML from a rendered message body element.
 * Strips tool chips, agent cards, SVGs, buttons, and copy buttons,
 * keeping only the prose content (markdown-rendered HTML).
 */
function extractRichHtml(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;

  // Remove tool/agent/UI elements
  clone.querySelectorAll('[data-tool-text], [data-agent-text], button, svg').forEach(n => n.remove());
  // Remove copy buttons specifically
  clone.querySelectorAll('[title="Copy"]').forEach(n => n.remove());

  // Find prose content divs (rendered markdown)
  const proseEls = clone.querySelectorAll('.prose');
  if (proseEls.length > 0) {
    const parts: string[] = [];
    proseEls.forEach(p => parts.push(p.innerHTML));
    return parts.join('<br>');
  }

  // Fallback: full innerHTML
  return clone.innerHTML;
}

/** Extract clean text from a DOM fragment, skipping tool chip decorations */
function extractCleanText(fragment: DocumentFragment): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent || '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;

    // Tool summary bars: emit their data-tool-text as a short notation
    const toolText = el.getAttribute('data-tool-text');
    if (toolText) {
      parts.push(`[${toolText}]`);
      return;
    }

    // Agent cards: emit their data-agent-text
    const agentText = el.getAttribute('data-agent-text');
    if (agentText) {
      parts.push(`[Agent: ${agentText}]`);
      return;
    }

    // Skip SVGs and buttons within tool UI
    if (el.tagName === 'SVG' || el.tagName === 'svg') return;

    // Block-level elements add newlines
    const display = getComputedStyle(el).display;
    const isBlock = display === 'block' || display === 'flex' || display === 'grid';

    if (isBlock && parts.length > 0 && !parts[parts.length - 1].endsWith('\n')) {
      parts.push('\n');
    }

    for (const child of Array.from(node.childNodes)) {
      walk(child);
    }

    if (isBlock && parts.length > 0 && !parts[parts.length - 1].endsWith('\n')) {
      parts.push('\n');
    }
  };

  for (const child of Array.from(fragment.childNodes)) {
    walk(child);
  }

  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return '0.0s';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const totalSeconds = Math.round(s);
  const m = Math.floor(totalSeconds / 60);
  const rem = totalSeconds % 60;
  return `${m}m ${rem}s`;
}

function fmtTokens(n: number): string {
  return `${(n / 1000).toFixed(1)}k`;
}

function getStopReasonLabel(reason?: string): string | null {
  switch (reason) {
    case 'length':
      return '출력 상한에서 종료';
    case 'toolUse':
      return '도구 호출로 종료';
    case 'error':
      return '오류로 종료';
    case 'aborted':
      return '중단됨';
    default:
      return null;
  }
}

/** Context usage label for avatar area — shows inputTokens as context size */
function fmtContextLabel(input: number): string | null {
  if (input <= 0) return null;
  return fmtTokens(input);
}

const CONTEXT_MAX_FALLBACK = 200_000;

export function TurnMetricsBar({ message, isLast }: { message?: ChatMessage; isLast?: boolean }) {
  const isStreaming = useActiveSessionStreaming();
  const turnStartTime = useChatStore((s) => s.turnStartTime);
  const lastTurnMetrics = useChatStore((s) => s.lastTurnMetrics);
  const [elapsed, setElapsed] = useState(0);

  const isLiveTimerTarget = !!isLast || !message;

  useEffect(() => {
    if (!isStreaming || !turnStartTime || !isLiveTimerTarget) {
      // Avoid scheduling a no-op state update on every render. In production,
      // React reports repeated render/effect state updates as minified error
      // #185 (maximum update depth exceeded).
      setElapsed((current) => (current === 0 ? current : 0));
      return;
    }
    const nextElapsed = () => Math.max(0, serverNowMs() - turnStartTime);
    setElapsed((current) => {
      const next = nextElapsed();
      return current === next ? current : next;
    });
    const iv = setInterval(() => {
      setElapsed((current) => {
        const next = nextElapsed();
        return current === next ? current : next;
      });
    }, LIVE_TURN_TIMER_INTERVAL_MS);
    return () => clearInterval(iv);
  }, [isStreaming, turnStartTime, isLiveTimerTarget]);

  // Streaming: live timer. AssistantPlaceholder passes no message, so the
  // running turn's elapsed time stays visible before the first assistant frame
  // arrives. Final per-message metrics below remain bubble-owned.
  if (isLiveTimerTarget && isStreaming && elapsed > 0) {
    return (
      <div className="inline-flex items-center gap-1.5 text-[12px] text-surface-500/75 tabular-nums font-medium dark:text-surface-600">
        <svg className="w-3 h-3 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        {fmtDuration(elapsed)}
      </div>
    );
  }

  // Per-message metrics (from DB or final turn_done event). While the *current*
  // last assistant placeholder is still streaming, Pi may persist per-iteration
  // metrics to DB; do not render those as the final elapsed time. Older bubbles
  // must keep their persisted metrics even while a newer turn is streaming.
  const hideCurrentStreamingPlaceholderMetrics = !!isLast && isStreaming;
  const msgMetrics = !hideCurrentStreamingPlaceholderMetrics && message?.durationMs != null
    ? {
        durationMs: message.durationMs,
        inputTokens: message.inputTokens || 0,
        outputTokens: message.outputTokens || 0,
        reasoningTokens: message.reasoningTokens,
        completedAt: message.completedAt,
        stopReason: message.stopReason,
      }
    : null;

  // Fallback to in-memory lastTurnMetrics only for a just-finished visible turn.
  // After reload/session switch, per-message durationMs from DB is the source of
  // truth. This prevents stale lastTurnMetrics from attaching to an older last
  // assistant bubble that merely happens to be visible.
  const canUseLastTurnFallback = !!isLast
    && !isStreaming
    && !msgMetrics
    && !!lastTurnMetrics
    && !!message
    && message.role === 'assistant'
    && Date.now() - message.timestamp < Math.max(30_000, lastTurnMetrics.durationMs + 5_000);
  const metrics = msgMetrics || (canUseLastTurnFallback ? lastTurnMetrics : null);
  const isFallbackMetrics = !msgMetrics && canUseLastTurnFallback;

  if (metrics) {
    const totalTokens = metrics.inputTokens + metrics.outputTokens;
    const stopReasonLabel = getStopReasonLabel(metrics.stopReason);
    return (
      <div className="flex flex-wrap items-center gap-1.5 mt-2 text-[13px] text-gray-500 tabular-nums font-medium">
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        {fmtDuration(metrics.durationMs)}
        {metrics.completedAt && !isStreaming && !isFallbackMetrics && metrics.stopReason !== 'toolUse' && (
          <>
            <span className="text-gray-600">·</span>
            <span title="응답 완료 시각">완료 {formatCompletionTime(metrics.completedAt)}</span>
          </>
        )}
        {stopReasonLabel && (
          <>
            <span className="text-gray-600">·</span>
            <span className={`tone-pill px-1.5 py-0.5 rounded ${metrics.stopReason === 'length' ? 'tone-warning' : metrics.stopReason === 'error' ? 'tone-danger' : 'tone-muted'}`}>
              {stopReasonLabel}
            </span>
          </>
        )}
      </div>
    );
  }

  return null;
}

/** Group consecutive blocks of the same type together */
interface BlockGroup {
  type: string;
  blocks: ContentBlock[];
}

function groupContentBlocks(blocks: ContentBlock[]): BlockGroup[] {
  const groups: BlockGroup[] = [];

  for (const block of blocks) {
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && lastGroup.type === block.type) {
      lastGroup.blocks.push(block);
    } else {
      groups.push({ type: block.type, blocks: [block] });
    }
  }

  return groups;
}
