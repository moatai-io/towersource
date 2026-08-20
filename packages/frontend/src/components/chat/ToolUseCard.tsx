import React, { useState, useEffect } from 'react';
import i18n from '../../i18n';
import { getToolActivityLabel, getToolLabel, getToolSummary } from '../../utils/message-parser';
import { safeStr } from '../shared/parse-loose-json';
import { useActiveSessionStreaming } from '../../hooks/useActiveSessionStreaming';
import { useActiveSessionTurnState } from '../../hooks/useActiveSessionTurnState';
import { isLinkableTowerPath, openTowerFile } from '../../utils/file-path-links';
import { RunIndicator } from '../common/RunIndicator';
import SecureInputBlock from './SecureInputBlock';
import { parseAskUserQuestionResult } from '../../utils/ask-user-question-result';

interface ToolUseCardProps {
  toolUseId?: string;
  name: string;
  input: Record<string, any>;
  result?: string;
  onFileClick?: (path: string) => void;
  compact?: boolean;
  defaultExpanded?: boolean;
  /** True only for the current live assistant turn. Historical unresolved tools must not animate. */
  isLive?: boolean;
}

interface ToolChipProps {
  toolUseId?: string;
  name: string;
  input: Record<string, any>;
  result?: string;
  isActive: boolean;
  isLive?: boolean;
  onClick: () => void;
}

const toolMeta: Record<string, { icon: React.ReactNode; color: string; bg: string; border: string }> = {
  Bash: {
    icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />,
    color: 'tone-success tone-text', bg: 'tone-success tone-bg-soft', border: 'tone-success tone-border',
  },
  Read: {
    icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />,
    color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20',
  },
  Write: {
    icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />,
    color: 'tone-warning tone-text', bg: 'tone-warning tone-bg-soft', border: 'tone-warning tone-border',
  },
  Edit: {
    icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />,
    color: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/20',
  },
  Glob: {
    icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />,
    color: 'text-cyan-400', bg: 'bg-cyan-500/10', border: 'border-cyan-500/20',
  },
  Grep: {
    icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 21h7a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v11m0 5l4.879-4.879m0 0a3 3 0 104.243-4.242 3 3 0 00-4.243 4.242z" />,
    color: 'text-violet-400', bg: 'bg-violet-500/10', border: 'border-violet-500/20',
  },
  Task: {
    icon: <><rect x="7" y="7" width="10" height="10" rx="1.5" strokeWidth={1.5} /><path strokeLinecap="round" strokeWidth={1.5} d="M9 3v4M12 3v4M15 3v4M9 17v4M12 17v4M15 17v4M3 9h4M3 12h4M3 15h4M17 9h4M17 12h4M17 15h4" /></>,
    color: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/20',
  },
  WebSearch: {
    icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />,
    color: 'text-teal-400', bg: 'bg-teal-500/10', border: 'border-teal-500/20',
  },
  WebFetch: {
    icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />,
    color: 'text-teal-400', bg: 'bg-teal-500/10', border: 'border-teal-500/20',
  },
  AskUserQuestion: {
    icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />,
    color: 'tone-warning tone-text', bg: 'tone-warning tone-bg-soft', border: 'tone-warning tone-border',
  },
  Credential_vault_input: {
    icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4" />,
    color: 'tone-warning tone-text', bg: 'tone-warning tone-bg-soft', border: 'tone-warning tone-border',
  },
  EnterPlanMode: {
    icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />,
    color: 'text-indigo-400', bg: 'bg-indigo-500/10', border: 'border-indigo-500/20',
  },
  ExitPlanMode: {
    icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />,
    color: 'text-indigo-400', bg: 'bg-indigo-500/10', border: 'border-indigo-500/20',
  },
  TodoWrite: {
    icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />,
    color: 'tone-accent tone-text', bg: 'tone-accent tone-bg-soft', border: 'tone-accent tone-border',
  },
};

const defaultMeta = {
  icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />,
  color: 'text-gray-400', bg: 'bg-gray-500/10', border: 'border-gray-500/20',
};

/** Case-insensitive lookup — SDK may send "bash" or "Bash" */
function getToolMeta(name: string) {
  return toolMeta[name] || toolMeta[name.charAt(0).toUpperCase() + name.slice(1)] || defaultMeta;
}

function normalizeToolName(name: string) {
  const shortName = name.split('.').pop()?.replace(/^functions__/, '') || name;
  return shortName.charAt(0).toUpperCase() + shortName.slice(1);
}

function toolKind(name: string) {
  return (name.split('.').pop() || name).replace(/^functions__/, '').toLowerCase();
}

const TOOL_RESULT_PREVIEW_LINES = 160;
const TOOL_RESULT_PREVIEW_CHARS = 40000;
const TOOL_FULL_RENDER_CHARS = 200000;
const TOOL_NEW_WINDOW_RENDER_CHARS = 1000000;
const TOOL_FILE_PATH_CHAR = String.raw`[\w.@\-,+#%()가-힣ㄱ-ㅎㅏ-ㅣ ]`;
const TOOL_FILE_PATH_SEGMENT = String.raw`${TOOL_FILE_PATH_CHAR}+`;
const TOOL_FILE_PATH_SEGMENT_NO_SPACE = String.raw`[\w.@\-,+#%()가-힣ㄱ-ㅎㅏ-ㅣ]+`;
const TOOL_FILE_PATH_EXT = String.raw`\.[A-Za-z0-9]+`;
const TOOL_ABS_FILE_PATH = String.raw`(?:/${TOOL_FILE_PATH_SEGMENT})+/${TOOL_FILE_PATH_SEGMENT}${TOOL_FILE_PATH_EXT}`;
const TOOL_ABS_DIR_PATH = String.raw`(?:/${TOOL_FILE_PATH_SEGMENT})+/`;
const TOOL_ABS_DIR_PATH_NO_TRAILING = String.raw`(?:/${TOOL_FILE_PATH_SEGMENT_NO_SPACE})+/${TOOL_FILE_PATH_SEGMENT_NO_SPACE}`;
const TOOL_HOME_FILE_PATH = String.raw`~/(?:${TOOL_FILE_PATH_SEGMENT}/)*${TOOL_FILE_PATH_SEGMENT}${TOOL_FILE_PATH_EXT}`;
const TOOL_HOME_DIR_PATH = String.raw`~/(?:${TOOL_FILE_PATH_SEGMENT}/)+`;
const TOOL_HOME_DIR_PATH_NO_TRAILING = String.raw`~/(?:${TOOL_FILE_PATH_SEGMENT_NO_SPACE}/)+${TOOL_FILE_PATH_SEGMENT_NO_SPACE}`;
const TOOL_REL_FILE_PATH = String.raw`\./(?:${TOOL_FILE_PATH_SEGMENT}/)*${TOOL_FILE_PATH_SEGMENT}${TOOL_FILE_PATH_EXT}`;
const TOOL_REL_DIR_PATH = String.raw`\./(?:${TOOL_FILE_PATH_SEGMENT}/)+`;
const TOOL_REL_DIR_PATH_NO_TRAILING = String.raw`\./(?:${TOOL_FILE_PATH_SEGMENT_NO_SPACE}/)+${TOOL_FILE_PATH_SEGMENT_NO_SPACE}`;
const TOOL_PLAIN_REL_FILE_PATH = String.raw`(?:${TOOL_FILE_PATH_SEGMENT}/)+${TOOL_FILE_PATH_SEGMENT}${TOOL_FILE_PATH_EXT}`;
const TOOL_PLAIN_REL_DIR_PATH = String.raw`(?:${TOOL_FILE_PATH_SEGMENT}/){2,}`;
const TOOL_PLAIN_REL_DIR_PATH_NO_TRAILING = String.raw`(?:${TOOL_FILE_PATH_SEGMENT_NO_SPACE}/){1,}${TOOL_FILE_PATH_SEGMENT_NO_SPACE}`;
const TOOL_FILE_PATH_REGEX = new RegExp(
  String.raw`(?:^|[\s"'\`(\[])((${TOOL_ABS_FILE_PATH})|(${TOOL_ABS_DIR_PATH})|(${TOOL_HOME_FILE_PATH})|(${TOOL_HOME_DIR_PATH})|(${TOOL_REL_FILE_PATH})|(${TOOL_REL_DIR_PATH})|(${TOOL_PLAIN_REL_FILE_PATH})|(${TOOL_PLAIN_REL_DIR_PATH})|(${TOOL_ABS_DIR_PATH_NO_TRAILING})|(${TOOL_HOME_DIR_PATH_NO_TRAILING})|(${TOOL_REL_DIR_PATH_NO_TRAILING})|(${TOOL_PLAIN_REL_DIR_PATH_NO_TRAILING}))(?=(?::\d+)?(?::\d+)?(?:[\s"'\`),\]]|$))`,
  'g',
);

function redactToolDisplayText(rawText: string) {
  return rawText
    .replace(/\b(authorization\s*:\s*bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/\b(cookie|set-cookie)\s*:\s*[^\n\r]+/gi, '$1: [redacted]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd|private[_-]?key|client[_-]?secret)\b([\w .-]{0,40})(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1$2$3[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, '[redacted-openai-key]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]');
}

function isProbablyBinaryText(text: string) {
  if (!text) return false;
  if (text.includes('\u0000')) return true;
  const sample = text.slice(0, 4096);
  const controlChars = sample.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g)?.length || 0;
  return sample.length > 0 && controlChars / sample.length > 0.02;
}

function isDotEnvPath(path: unknown) {
  const text = safeStr(path).toLowerCase();
  return /(?:^|\/)\.env(?:\.|$)/.test(text) || /(?:^|\/)\.env$/.test(text);
}

function isSensitiveToolOutput(kind: string, input: Record<string, any>) {
  if (isDotEnvPath(input.path) || isDotEnvPath(input.file_path)) return true;
  const command = safeStr(input.command).toLowerCase();
  return kind === 'bash' && /\b(cat|grep|rg|sed|awk|head|tail|less|more|xxd|strings)\b[^\n;&|]*(?:[\s/]|^)\.env(?:[.\s/]|$)/.test(command);
}

function makeHeadTailPreview(text: string, maxLines = TOOL_RESULT_PREVIEW_LINES, maxChars = TOOL_RESULT_PREVIEW_CHARS) {
  const split = text.split(/\r?\n/);
  const lineTruncated = split.length > maxLines;
  const headCount = Math.ceil(maxLines * 0.65);
  const tailCount = maxLines - headCount;
  let preview = lineTruncated
    ? [
        ...split.slice(0, headCount),
        i18n.t('chat:toolOutputMiddleOmitted', { count: Math.max(0, split.length - maxLines).toLocaleString() }),
        ...split.slice(-tailCount),
      ].join('\n')
    : text;
  let truncated = lineTruncated;
  if (preview.length > maxChars) {
    preview = `${preview.slice(0, maxChars)}\n${i18n.t('chat:toolOutputCharactersOmitted', { count: Math.max(0, text.length - maxChars).toLocaleString() })}`;
    truncated = true;
  }
  return { text: preview, truncated, totalLines: split.length, totalChars: text.length };
}

function ToolFileLink({ path, onFileClick, className = '' }: { path: string; onFileClick?: (path: string) => void; className?: string }) {
  return (
    <button
      type="button"
      className={`cursor-pointer text-left font-mono underline decoration-current/40 underline-offset-2 hover:opacity-80 ${className}`}
      onClick={(e) => {
        e.stopPropagation();
        if (onFileClick) onFileClick(path);
        else openTowerFile(path);
      }}
      title={`Open ${path}`}
    >
      {path}
    </button>
  );
}

function openToolTextInNewWindow(text: string, title = 'Tool output') {
  const child = window.open('', '_blank');
  if (!child) return false;
  try { child.opener = null; } catch { /* best-effort */ }

  const fullTooLarge = text.length > TOOL_NEW_WINDOW_RENDER_CHARS;
  const visibleText = fullTooLarge
    ? `${text.slice(0, TOOL_NEW_WINDOW_RENDER_CHARS)}\n${i18n.t('chat:toolOutputWindowCharactersOmitted', { count: Math.max(0, text.length - TOOL_NEW_WINDOW_RENDER_CHARS).toLocaleString() })}`
    : text;
  const doc = child.document;
  doc.title = title;
  doc.body.replaceChildren();
  const style = doc.createElement('style');
  style.textContent = `
    :root { color-scheme: dark; }
    body { margin: 0; background: #0b0f19; color: #d1d5db; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { position: sticky; top: 0; z-index: 1; padding: 12px 16px; border-bottom: 1px solid rgba(148, 163, 184, 0.24); background: rgba(11, 15, 25, 0.96); backdrop-filter: blur(8px); }
    .title { font-size: 13px; font-weight: 700; color: #f9fafb; }
    .meta { margin-top: 3px; font-size: 12px; color: #9ca3af; }
    pre { margin: 0; padding: 16px; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
  `;
  const header = doc.createElement('header');
  const heading = doc.createElement('div');
  heading.className = 'title';
  heading.textContent = title;
  const meta = doc.createElement('div');
  meta.className = 'meta';
  meta.textContent = i18n.t('chat:toolOutputMeta', { lines: visibleText.split(/\r?\n/).length.toLocaleString(), characters: visibleText.length.toLocaleString(), limit: fullTooLarge ? i18n.t('chat:renderLimitAppliedSuffix') : '' });
  const pre = doc.createElement('pre');
  pre.textContent = visibleText;
  header.append(heading, meta);
  doc.head.appendChild(style);
  doc.body.append(header, pre);
  child.focus();
  return true;
}

function renderToolTextWithPathLinks(text: string, onFileClick?: (path: string) => void): React.ReactNode {
  if (!onFileClick || !text) return text;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  const regex = new RegExp(TOOL_FILE_PATH_REGEX.source, 'g');

  for (const match of text.matchAll(regex)) {
    const fullMatch = match[0];
    const filePath = match[1];
    const pathStart = (match.index ?? 0) + fullMatch.indexOf(filePath);
    if (!isLinkableTowerPath(filePath)) continue;
    if (pathStart > lastIndex) parts.push(text.slice(lastIndex, pathStart));
    parts.push(
      <ToolFileLink
        key={`${pathStart}-${filePath}`}
        path={filePath}
        onFileClick={onFileClick}
        className="text-primary-300/90"
      />,
    );
    lastIndex = pathStart + filePath.length;
  }

  if (parts.length === 0) return text;
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <>{parts}</>;
}

function ToolTextBlock({
  raw,
  onFileClick,
  className = '',
  previewLines = TOOL_RESULT_PREVIEW_LINES,
  sensitive = false,
}: {
  raw: unknown;
  onFileClick?: (path: string) => void;
  className?: string;
  previewLines?: number;
  sensitive?: boolean;
}) {
  const [showFull, setShowFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);

  if (sensitive) {
    return (
      <div className={`rounded-lg border border-amber-500/20 bg-amber-950/20 p-3 text-[13px] text-amber-200/90 ${className}`}>
        {i18n.t('chat:sensitiveToolOutputHidden')}
      </div>
    );
  }

  const fullText = redactToolDisplayText(safeStr(raw));
  if (isProbablyBinaryText(fullText)) {
    return (
      <div className={`rounded-lg border border-surface-700/50 bg-surface-950/60 p-3 text-[13px] text-gray-400 ${className}`}>
        {i18n.t('chat:binaryToolOutputHidden')}
      </div>
    );
  }

  const preview = makeHeadTailPreview(fullText, previewLines);
  const fullTooLarge = fullText.length > TOOL_FULL_RENDER_CHARS;
  const displayText = showFull
    ? (fullTooLarge
        ? `${fullText.slice(0, TOOL_FULL_RENDER_CHARS)}\n${i18n.t('chat:toolOutputCharactersOmittedForRendering', { count: Math.max(0, fullText.length - TOOL_FULL_RENDER_CHARS).toLocaleString() })}`
        : fullText)
    : preview.text;
  const canExpand = preview.truncated && !showFull;

  const copyVisibleText = async () => {
    try {
      await navigator.clipboard?.writeText(displayText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  const openInNewWindow = () => {
    const opened = openToolTextInNewWindow(fullText, 'Tool output');
    setOpenFailed(!opened);
  };

  return (
    <div className="space-y-2">
      {(preview.truncated || showFull) && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-gray-500">
          <span>
            {i18n.t('chat:toolOutputPreviewMeta', { view: showFull ? i18n.t('chat:fullView') : i18n.t('chat:preview'), lines: preview.totalLines.toLocaleString(), characters: preview.totalChars.toLocaleString() })}
          </span>
          {canExpand && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setShowFull(true); }}
              className="rounded-md border border-surface-700/50 px-2 py-0.5 text-gray-300 hover:bg-surface-800/70"
            >
              {i18n.t('chat:showFullOutput')}
            </button>
          )}
          {showFull && preview.truncated && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setShowFull(false); }}
              className="rounded-md border border-surface-700/50 px-2 py-0.5 text-gray-400 hover:bg-surface-800/70"
            >
              {i18n.t('chat:collapseToPreview')}
            </button>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); openInNewWindow(); }}
            className="rounded-md border border-surface-700/50 px-2 py-0.5 text-gray-400 hover:bg-surface-800/70"
          >
            {i18n.t('chat:openInNewWindow')}
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void copyVisibleText(); }}
            className="rounded-md border border-surface-700/50 px-2 py-0.5 text-gray-400 hover:bg-surface-800/70"
          >
            {copied ? i18n.t('chat:copied') : i18n.t('chat:copyVisibleContent')}
          </button>
          {openFailed && <span className="text-amber-300/80">{i18n.t('chat:popupBlocked')}</span>}
          {fullTooLarge && showFull && <span className="text-amber-300/80">{i18n.t('chat:renderLimitApplied', { count: TOOL_FULL_RENDER_CHARS.toLocaleString() })}</span>}
        </div>
      )}
      <div className={`bg-surface-950/60 rounded-lg p-3 font-mono text-[13px] overflow-x-auto max-h-[36rem] overflow-y-auto whitespace-pre-wrap ${className}`}>
        {renderToolTextWithPathLinks(displayText, onFileClick)}
      </div>
    </div>
  );
}

export function ToolChip({ toolUseId, name, input, result, isActive, isLive = false, isLast, onClick }: ToolChipProps & { isLast?: boolean }) {
  const isStreaming = useActiveSessionStreaming();
  const activeTurn = useActiveSessionTurnState();
  const summary = getToolSummary(name, input);
  const activityLabel = getToolActivityLabel(name, input);
  const toolId = toolUseId || `${name}:${summary}`;
  const isCurrentTool = activeTurn.activeToolUseId
    ? activeTurn.activeToolUseId === toolUseId
    : (!!activeTurn.activeToolId
      ? activeTurn.activeToolId === toolId
      : (!!activeTurn.activeToolSummary && activeTurn.activeToolSummary === summary));
  const isRunning = !!isLive && !result && isStreaming && (isCurrentTool || activeTurn.phase === 'tool_running' || isLast);
  const meta = getToolMeta(name);

  if (toolKind(name) === 'present_file' && result) return null;

  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border cursor-pointer transition-all duration-150 text-[13px] max-w-[200px] ${
        isActive
          ? `${meta.bg} ${meta.border}`
          : `bg-transparent border-surface-700/40 hover:border-surface-600/60 hover:bg-surface-800/40`
      }`}
    >
      <svg className={`w-3 h-3 ${meta.color} shrink-0 opacity-70`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        {meta.icon}
      </svg>
      <span
        className={`truncate ${isActive ? meta.color : 'text-gray-500'}`}
        title={isRunning ? `${activityLabel} · ${summary} · ${name}` : `${summary} · ${name}`}
      >
        {isRunning ? activityLabel : summary}
      </span>
      {isRunning && (
        <span className="inline-flex items-center gap-1 text-[11px] text-primary-400 font-medium shrink-0">
          <RunIndicator size="xs" label="" />
        </span>
      )}
      {result && (
        <svg className="w-2.5 h-2.5 tone-success tone-text opacity-60 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      )}
    </button>
  );
}

/* ── TodoWrite Checklist ── */

interface TodoItem {
  content: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
}

function TodoChecklist({ todos }: { todos: TodoItem[] }) {
  // ToolUseCard expanded view is always historical — no spinners
  const total = todos.length;
  const completed = todos.filter(t => t.status === 'completed').length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const allDone = completed === total;

  return (
    <div className="tower-ui-block-space">
      <div className="text-[13px] font-semibold text-gray-400">{i18n.t('chat:workSteps')}</div>
      {/* Progress bar */}
      <div className="flex items-center tower-ui-block-gap">
        <div className="flex-1 h-1 bg-surface-800 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500 ease-out"
            style={{
              width: `${pct}%`,
              background: allDone ? 'linear-gradient(90deg, var(--tone-success-text), color-mix(in srgb, var(--tone-success-text) 70%, white))' : '#6b7280',
            }}
          />
        </div>
        <span className={`text-[13px] font-mono tabular-nums ${allDone ? 'tone-success tone-text' : 'text-gray-500'}`}>
          {completed}/{total}
        </span>
      </div>

      {/* Todo items — static snapshot */}
      <div className="space-y-0.5">
        {todos.map((todo, i) => (
          <div key={i} className="flex items-start tower-ui-block-gap px-1.5 py-0.5 rounded-md">
            {todo.status === 'completed' ? (
              <svg className="tower-ui-block-icon tone-success tone-text shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : (
              <div className="tower-ui-block-icon shrink-0 mt-0.5 flex items-center justify-center">
                <div className={`w-2.5 h-2.5 rounded-full border-[1.5px] ${
                  todo.status === 'in_progress' ? 'border-gray-500 bg-gray-500/20' : 'border-gray-600'
                }`} />
              </div>
            )}
            <span className={`text-ui-block-size leading-relaxed ${
              todo.status === 'completed' ? 'text-gray-500 line-through' : 'text-gray-400'
            }`}>
              {safeStr(todo.content || (todo as any).title)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ToolUseCard({ toolUseId, name, input, result, onFileClick, compact, defaultExpanded, isLive = false }: ToolUseCardProps) {
  const isStreaming = useActiveSessionStreaming();
  const activeTurn = useActiveSessionTurnState();
  const summary = getToolSummary(name, input);
  const activityLabel = getToolActivityLabel(name, input);
  const toolId = toolUseId || `${name}:${summary}`;
  const isCurrentTool = activeTurn.activeToolUseId
    ? activeTurn.activeToolUseId === toolUseId
    : (!!activeTurn.activeToolId
      ? activeTurn.activeToolId === toolId
      : (!!activeTurn.activeToolSummary && activeTurn.activeToolSummary === summary));
  const isRunning = !!isLive && !result && isStreaming && (isCurrentTool || activeTurn.phase === 'tool_running' || activeTurn.phase === 'preparing');

  // Interactive prompts and their completed decision trail must be visible
  // immediately instead of hiding behind the generic tool summary.
  const startsExpanded = defaultExpanded ?? ['credential_vault_input', 'askuserquestion'].includes(toolKind(name));
  const [expanded, setExpanded] = useState(startsExpanded);
  const [resultExpanded, setResultExpanded] = useState(true);

  const meta = getToolMeta(normalizeToolName(name));
  const label = getToolLabel(normalizeToolName(name));
  const kind = toolKind(name);
  const auqHistory = kind === 'askuserquestion' && Array.isArray(input.questions)
    ? resolveAskUserQuestionHistory(input.questions, result, input.answers)
    : null;
  const filePath = input.file_path || input.path;
  const presentedInfo = kind === 'present_file' ? (() => {
    try {
      const parsed = result ? JSON.parse(result) : {};
      return {
        path: input.path || parsed.path,
        label: input.label || parsed.label,
        split: input.split || input.pane || parsed.split || parsed.pane,
      };
    } catch {
      return { path: input.path, label: input.label, split: input.split || input.pane };
    }
  })() : undefined;
  const editOldText = input.old_string || input.oldText || input.old_text || input.edits?.[0]?.oldText;
  const editNewText = input.new_string || input.newText || input.new_text || input.edits?.[0]?.newText;

  // Keep hooks above conditional render exits. AskUserQuestion changes from an
  // unanswered hidden row to completed history in-place, so returning before a
  // later hook changes the hook count between those renders (React error #310).
  useEffect(() => {
    if (result) {
      // Keep expanded briefly then allow manual collapse
    }
  }, [result]);

  if (kind === 'present_file' && result) return null;
  // While the floating AUQ is active it is the single interaction surface.
  // Do not duplicate the same unanswered prompt in the chat history behind it.
  if (kind === 'askuserquestion' && !auqHistory) return null;

  if (kind === 'askuserquestion' && auqHistory && Array.isArray(input.questions)) {
    return <CompactAskUserQuestionHistory questions={input.questions} history={auqHistory} />;
  }

  return (
    <div className={`rounded-xl overflow-hidden border ${meta.border} ${meta.bg} backdrop-blur-sm transition-all duration-200`}>
      {/* Header — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-full flex items-center gap-3 hover:bg-white/[0.03] transition-colors ${compact ? 'px-3 py-2' : 'px-4 py-3'}`}
      >
        {/* Icon */}
        <div className={`${compact ? 'w-5 h-5 rounded-md' : 'w-7 h-7 rounded-lg'} ${meta.bg} border ${meta.border} flex items-center justify-center shrink-0`}>
          <svg className={`${compact ? 'w-3 h-3' : 'w-4 h-4'} ${meta.color}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {meta.icon}
          </svg>
        </div>

        {/* Label + Summary */}
        <div className="flex-1 text-left min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-[15px] font-semibold ${meta.color}`}>{label}</span>
            {isRunning && (
              <span className="flex items-center gap-1 text-[13px] text-primary-400 font-medium">
                <RunIndicator size="xs" label="" />
                {activityLabel}
              </span>
            )}
            {result && !isRunning && (
              <span className="text-[13px] tone-success tone-text opacity-80 font-medium flex items-center gap-1">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Done
              </span>
            )}
          </div>
          {!compact && <div className="text-[14px] text-gray-500 truncate mt-0.5">{summary}</div>}
        </div>

        {/* Expand chevron */}
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform duration-200 shrink-0 ${expanded ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-white/[0.06] tower-ui-block-density space-y-2">
          {/* === Bash === */}
          {kind === 'bash' && input.command && (
            <div className="bg-surface-950/60 rounded-lg p-3 font-mono text-[14px] overflow-x-auto whitespace-pre-wrap">
              <span className="tone-accent tone-text opacity-60 select-none">$ </span>
              <span className="tone-success tone-text">{renderToolTextWithPathLinks(safeStr(input.command), onFileClick)}</span>
            </div>
          )}

          {/* === Present file — direct artifact link === */}
          {presentedInfo?.path && kind === 'present_file' && (
            <div className="flex items-center gap-2 text-[14px] min-w-0">
              <span className="text-gray-500 shrink-0">Presented{presentedInfo.split ? ` · ${presentedInfo.split}` : ''}</span>
              <ToolFileLink path={presentedInfo.path} onFileClick={onFileClick} className={`${meta.color} truncate`} />
              {presentedInfo.label && <span className="text-gray-500 truncate">{presentedInfo.label}</span>}
            </div>
          )}

          {/* === Read / Write / Edit — file path === */}
          {filePath && ['read', 'write', 'edit'].includes(kind) && (
            <div className="flex items-center gap-2 text-[14px] min-w-0">
              <span className="text-gray-500 shrink-0">Path</span>
              <ToolFileLink path={filePath} onFileClick={onFileClick} className={`${meta.color} truncate`} />
            </div>
          )}

          {/* === Search/list tool invocation — keep the call payload, but link file paths inside it === */}
          {['grep', 'glob', 'find', 'ls'].includes(kind) && Object.keys(input).length > 0 && (
            <ToolTextBlock raw={JSON.stringify(input, null, 2)} onFileClick={onFileClick} className="text-gray-400" />
          )}

          {/* === Edit — diff view === */}
          {kind === 'edit' && editOldText && (
            <div className="space-y-1.5 mt-1">
              <ToolTextBlock raw={editOldText} onFileClick={onFileClick} className="text-red-300/90 bg-red-950/20 border-l-2 border-red-500/50 rounded-r-lg" />
              <ToolTextBlock raw={editNewText} onFileClick={onFileClick} className="tone-card tone-success border-l-2 rounded-r-lg" />
            </div>
          )}

          {/* === Write — content preview === */}
          {kind === 'write' && input.content && (
            <ToolTextBlock raw={input.content} onFileClick={onFileClick} className="text-gray-400" sensitive={isSensitiveToolOutput(kind, input)} />
          )}

          {/* === Task (subagent) === */}
          {kind === 'task' && (
            <div className="text-[14px] space-y-1">
              {input.description && <div className="text-gray-300 font-medium">{input.description}</div>}
              {input.prompt && (
                <div className="bg-surface-950/60 rounded-lg p-3 text-gray-400 text-[13px] max-h-24 overflow-y-auto">
                  {input.prompt.slice(0, 300)}{input.prompt.length > 300 ? '...' : ''}
                </div>
              )}
            </div>
          )}

          {/* === AskUserQuestion — badge only (floating card handles interaction) === */}
          {kind === 'askuserquestion' && input.questions && (
            <AskUserQuestionBadge questions={input.questions as any[]} result={result} inputAnswers={input.answers} />
          )}

          {kind === 'credential_vault_input' && (
            <SecureCredentialToolInput input={input} result={result} />
          )}

          {/* === EnterPlanMode / ExitPlanMode === */}
          {(kind === 'enterplanmode' || kind === 'exitplanmode') && (
            <div className={`tone-card flex items-center gap-2 px-3 py-2 rounded-lg ${kind === 'enterplanmode' ? 'tone-info' : 'tone-success'}`}>
              <span className="text-[14px] font-medium tone-text">
                {kind === 'enterplanmode' ? 'Entering plan mode' : 'Plan complete - starting implementation'}
              </span>
            </div>
          )}

          {/* === TodoWrite — checklist === */}
          {kind === 'todowrite' && Array.isArray(input.todos) && input.todos.length > 0 && (
            <TodoChecklist todos={input.todos as TodoItem[]} />
          )}

          {/* === Generic fallback === */}
          {!['bash', 'read', 'write', 'edit', 'grep', 'glob', 'find', 'ls', 'task', 'askuserquestion', 'credential_vault_input', 'enterplanmode', 'exitplanmode', 'todowrite', 'present_file'].includes(kind) && Object.keys(input).length > 0 && (
            <ToolTextBlock raw={JSON.stringify(input, null, 2)} onFileClick={onFileClick} className="text-gray-400" />
          )}

          {/* === Result === */}
          {result && !['present_file', 'credential_vault_input', 'askuserquestion'].includes(kind) && (
            <div className="mt-2">
              <button
                onClick={(e) => { e.stopPropagation(); setResultExpanded(!resultExpanded); }}
                className="flex items-center gap-1.5 text-[13px] text-gray-500 hover:text-gray-300 transition-colors mb-1.5"
              >
                <svg className={`w-3 h-3 transition-transform ${resultExpanded ? 'rotate-90' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                Result
                <span className="text-gray-400">({result.length.toLocaleString()} chars)</span>
              </button>
              {resultExpanded && (
                <ToolTextBlock raw={result} onFileClick={onFileClick} className="text-gray-300" sensitive={isSensitiveToolOutput(kind, input)} />
              )}
            </div>
          )}

          {/* Running indicator */}
          {isRunning && !result && kind !== 'askuserquestion' && (
            <div className="flex items-center gap-2 text-[13px] text-primary-400/70 pt-1">
              <div className="w-3 h-3 border-2 border-primary-500/30 border-t-primary-400 rounded-full animate-spin" />
              {activityLabel}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SecureCredentialToolInput({ input, result }: { input: Record<string, any>; result?: string }) {
  if (result?.includes('refused:')) return <div className="text-[13px] text-red-400">{result}</div>;
  const scope = input.scope || 'project';
  const inputType = input.inputType || 'value';
  const credentialId = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : 'credential';
  const provider = typeof input.provider === 'string' && input.provider.trim() ? input.provider.trim() : 'custom';
  const displayName = typeof input.displayName === 'string' && input.displayName.trim() ? input.displayName.trim() : 'Credential';
  const topLevelEnvName = typeof input.envName === 'string' && input.envName.trim() ? input.envName.trim() : 'SECRET_VALUE';
  const baseCredential = {
    provider,
    scope,
    grantToCurrentProject: input.grantToCurrentProject ?? scope === 'project',
    metadata: {
      purpose: input.purpose || undefined,
      handling_note: input.handlingNote || undefined,
      input_type: inputType,
      credential_group: credentialId,
    },
  };
  const fields = inputType === 'fields'
    ? (Array.isArray(input.fields) ? input.fields : []).map((field: any, index: number) => {
        const fieldKey = typeof field?.key === 'string' && field.key.trim() ? field.key.trim() : `SECRET_${index + 1}`;
        const fieldLabel = typeof field?.label === 'string' && field.label.trim() ? field.label.trim() : fieldKey;
        return {
          key: fieldKey,
          label: fieldLabel,
          required: field?.required ?? true,
          credential: {
            ...baseCredential,
            id: `${credentialId}-${fieldKey.toLowerCase().replaceAll('_', '-')}`,
            displayName: `${displayName} — ${fieldLabel}`,
            secretName: fieldKey,
            envName: fieldKey,
          },
        };
      })
    : [{
        key: topLevelEnvName,
        label: displayName,
        required: true,
        inputType: inputType === 'json' ? 'json' : 'password',
      }];
  const spec = JSON.stringify({
    target: 'credential-vault',
    fields,
    credential: inputType === 'fields' ? baseCredential : {
      ...baseCredential,
      id: credentialId,
      displayName,
      secretName: topLevelEnvName,
      envName: topLevelEnvName,
    },
  });
  return <SecureInputBlock raw={spec} fallbackCode={spec} />;
}

function questionText(question: any): string {
  return safeStr(question?.question || question?.prompt || question?.title || question?.label);
}

function questionOptions(question: any): Array<{ label: string; description?: string }> {
  if (!Array.isArray(question?.options)) return [];
  return question.options.map((option: any) => {
    if (typeof option === 'string') return { label: option };
    return {
      label: safeStr(option?.label || option?.value),
      description: option?.description ? safeStr(option.description) : undefined,
    };
  }).filter((option: { label: string }) => !!option.label);
}

function resolveAskUserQuestionHistory(questions: any[], result?: string, inputAnswers?: Record<string, string>) {
  const answerEntries = inputAnswers && typeof inputAnswers === 'object' ? Object.entries(inputAnswers) : [];
  const nativeAnswerResult = answerEntries.length > 0
    ? answerEntries.map(([question, answer]) => `${question}: ${answer}`).join('\n')
    : undefined;
  // Claude's native AUQ path records answers in the tool input, while Pi stores
  // the structured display envelope as the tool result. Read both histories.
  return parseAskUserQuestionResult(result || nativeAnswerResult, questions);
}

function CompactAskUserQuestionHistory({ questions, history }: {
  questions: any[];
  history: NonNullable<ReturnType<typeof parseAskUserQuestionResult>>;
}) {
  const statusLabel = history.status === 'skipped'
    ? i18n.t('chat:questionSkipped')
    : history.status === 'timed_out'
      ? i18n.t('chat:questionTimedOut')
      : history.status === 'error'
        ? i18n.t('chat:questionResponseStopped')
        : i18n.t('chat:questionAnswered');
  const visibleAnswerRows = questions.map((question, questionIndex) => ({
    question: questionText(question),
    answer: history.status === 'answered'
      ? (history.answers[questionIndex]?.answer && history.answers[questionIndex].answer !== '[미응답]'
        ? history.answers[questionIndex].answer
        : i18n.t('chat:noAnswer'))
      : statusLabel,
  }));
  const optionCount = questions.reduce((count, question) => count + questionOptions(question).length, 0);
  const selectedOptionCount = questions.reduce((count, question, questionIndex) => {
    const optionLabels = new Set(questionOptions(question).map(option => option.label));
    return count + (history.answers[questionIndex]?.selected || []).filter(value => optionLabels.has(value)).length;
  }, 0);
  const otherOptionCount = Math.max(0, optionCount - selectedOptionCount);
  const detailLabel = otherOptionCount > 0
    ? i18n.t('chat:otherOptions', { count: otherOptionCount })
    : i18n.t('chat:viewQuestion');

  return (
    <details className="group/auq border-y border-surface-800/55 py-1.5" data-testid="ask-user-question-compact-history">
      <summary className="cursor-pointer list-none px-1 marker:hidden">
        <div className="space-y-1">
          {visibleAnswerRows.map((row, rowIndex) => (
            <div key={`${row.question}-${rowIndex}`} className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-1 text-[12px] leading-snug">
              <span className="row-span-2 shrink-0 font-semibold text-surface-500" aria-label={rowIndex === 0 ? statusLabel : undefined}>{history.status === 'answered' ? '✓' : '·'}</span>
              <span className="min-w-0 truncate text-surface-400">{row.question}</span>
              <span className="min-w-0 truncate font-medium text-surface-200">{row.answer}</span>
            </div>
          ))}
        </div>
        <div className="mt-1 flex items-center justify-end gap-1 text-[12px] leading-snug">
          <span className="text-surface-500 group-hover/auq:text-surface-300">{detailLabel}</span>
          <svg className="h-3.5 w-3.5 shrink-0 text-surface-600 transition-transform group-open/auq:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </summary>
      <div className="mt-1.5 space-y-2 border-t border-surface-700/35 px-1 pt-2">
        {questions.map((question, questionIndex) => {
          const selected = new Set(history.answers[questionIndex]?.selected || []);
          const options = questionOptions(question);
          const customAnswers = (history.answers[questionIndex]?.selected || [])
            .filter(value => !options.some(option => option.label === value));
          return (
            <div key={questionIndex} className="space-y-1.5">
              <div className="text-[12px] leading-relaxed text-surface-400">{questionText(question)}</div>
              {options.map((option, optionIndex) => (
                <div key={`${option.label}-${optionIndex}`} className="flex items-start gap-1.5 text-[12px] leading-relaxed">
                  <span className={selected.has(option.label) ? 'text-surface-400' : 'text-surface-600'}>{selected.has(option.label) ? '✓' : '·'}</span>
                  <span className={selected.has(option.label) ? 'font-medium text-surface-200' : 'text-surface-500'}>{option.label}</span>
                  {option.description && <span className="text-surface-600">· {option.description}</span>}
                </div>
              ))}
              {customAnswers.map(customAnswer => (
                <div key={customAnswer} className="flex items-start gap-1.5 text-[12px] leading-relaxed">
                  <span className="text-surface-400">✓</span>
                  <span className="font-medium text-surface-200">{i18n.t('chat:customAnswer', { answer: customAnswer })}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function AskUserQuestionBadge({ questions, result, inputAnswers }: { questions: any[]; result?: string; inputAnswers?: Record<string, string> }) {
  const history = resolveAskUserQuestionHistory(questions, result, inputAnswers);
  const statusLabel = history?.status === 'skipped'
    ? i18n.t('chat:questionSkipped')
    : history?.status === 'timed_out'
      ? i18n.t('chat:questionResponseTimedOut')
      : history?.status === 'error'
        ? i18n.t('chat:questionResponseStopped')
        : history
          ? i18n.t('chat:decisionComplete')
          : i18n.t('chat:awaitingResponse');

  return (
    <div className="space-y-3" data-testid="ask-user-question-history">
      <div className="flex items-center gap-1.5 text-[13px]" style={{ color: history ? 'var(--th-q-done-accent)' : 'var(--th-text-muted)' }}>
        {history ? (
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <div className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-gray-600 border-t-gray-400" />
        )}
        <span className="font-medium">{statusLabel}</span>
      </div>

      {questions.map((question: any, questionIndex: number) => {
        const answer = history?.answers[questionIndex];
        const selected = new Set(answer?.selected || []);
        const options = questionOptions(question);
        const customAnswers = (answer?.selected || []).filter(value => !options.some(option => option.label === value));

        if (history) {
          return (
            <div key={questionIndex} className="space-y-1.5 border-t border-surface-700/35 pt-2.5 first:border-t-0 first:pt-0">
              <div className="text-[14px] font-medium leading-snug text-surface-100">{questionText(question)}</div>
              {history.status === 'answered' && answer?.answer && answer.answer !== '[미응답]' ? (
                <div className="flex items-start gap-2 text-[13px]">
                  <span className="mt-px shrink-0" style={{ color: 'var(--th-q-done-accent)' }}>✓</span>
                  <span className="whitespace-normal break-words font-medium text-surface-200">{answer.answer}</span>
                </div>
              ) : history.status === 'answered' ? (
                <div className="text-[13px] text-surface-500">{i18n.t('chat:noAnswer')}</div>
              ) : null}
              <details className="group/options">
                <summary className="cursor-pointer list-none text-[12px] text-surface-500 hover:text-surface-300 marker:hidden">
                  {i18n.t('chat:viewOptions', { count: options.length })}
                </summary>
                <div className="mt-1.5 space-y-1 border-l border-surface-700/40 pl-2.5">
                  {options.map((option, optionIndex) => {
                    const isSelected = selected.has(option.label);
                    return (
                      <div key={`${option.label}-${optionIndex}`} className="flex items-start gap-2 text-[12px] leading-relaxed">
                        <span className="w-3 shrink-0 text-center" style={{ color: isSelected ? 'var(--th-q-done-accent)' : 'var(--th-text-muted)' }}>
                          {isSelected ? '✓' : '·'}
                        </span>
                        <span className={isSelected ? 'font-medium text-surface-200' : 'text-surface-500'}>{option.label}</span>
                        {option.description && <span className="text-surface-600">· {option.description}</span>}
                      </div>
                    );
                  })}
                  {customAnswers.map(customAnswer => (
                    <div key={customAnswer} className="flex items-start gap-2 text-[12px] leading-relaxed">
                      <span className="w-3 shrink-0 text-center" style={{ color: 'var(--th-q-done-accent)' }}>✓</span>
                      <span className="font-medium text-surface-200">{i18n.t('chat:customAnswer', { answer: customAnswer })}</span>
                    </div>
                  ))}
                </div>
              </details>
            </div>
          );
        }

        return (
          <div key={questionIndex} className="space-y-2 border-t border-surface-700/35 pt-3 first:border-t-0 first:pt-0">
            <div className="text-[14px] font-medium leading-snug text-surface-100">{questionText(question)}</div>
            {options.length > 0 && (
              <div className="space-y-1 text-[12px] text-surface-500">
                {options.map((option, optionIndex) => <div key={`${option.label}-${optionIndex}`}>{optionIndex + 1}. {option.label}</div>)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

