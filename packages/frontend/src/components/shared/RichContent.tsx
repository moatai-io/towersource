import React, { useMemo, Suspense } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import { toastSuccess, toastError } from '../../utils/toast';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
const MermaidBlock = React.lazy(() => import('../chat/MermaidBlock').then((module) => ({ default: module.MermaidBlock })));
import { splitDynamicBlocks, type DynamicBlock } from './split-dynamic-blocks';
import { useActiveSessionStreaming } from '../../hooks/useActiveSessionStreaming';
import { fileServeUrl, fileThumbnailUrl, hasPreviewableFileExt, isPreviewableImageFilePath, isTowerLocalPath, openTowerFileInBrowserTab, revealTowerFileInSidebar, splitFilePathsInText as splitTowerFilePathsInText } from '../../utils/file-path-links';
import { normalizeMarkdownEmphasisBoundaries } from '../../utils/markdown-emphasis';
import { remarkGfmPlugin } from '../../utils/markdown-plugins';

// remark-math: disable inline $ to avoid $100 / $USD conflicts
const remarkMathOptions = { singleDollarTextMath: false };

// Lazy-loaded visual blocks
// Frequently-used blocks are preloaded after initial render (see bottom of file)
// so they're available instantly when scrolling into view.
const ChartBlock = React.lazy(() => import('../chat/ChartBlock'));
const SecureInputBlock = React.lazy(() => import('../chat/SecureInputBlock'));
const DataTableBlock = React.lazy(() => import('../chat/DataTableBlock'));
const HtmlSandboxBlock = React.lazy(() => import('../chat/HtmlSandboxBlock'));
const SvgBlock = React.lazy(() => import('../chat/SvgBlock'));
const TimelineBlock = React.lazy(() => import('../chat/TimelineBlock'));
const MapBlock = React.lazy(() => import('../chat/MapBlock'));
const StepsBlock = React.lazy(() => import('../chat/StepsBlock'));
const DiffBlock = React.lazy(() => import('../chat/DiffBlock'));
const FormBlock = React.lazy(() => import('../chat/FormBlock'));
const KanbanBlock = React.lazy(() => import('../chat/KanbanBlock'));
const TerminalBlock = React.lazy(() => import('../chat/TerminalBlock'));
const ComparisonBlock = React.lazy(() => import('../chat/ComparisonBlock'));
const TreemapBlock = React.lazy(() => import('../chat/TreemapBlock'));
const GalleryBlock = React.lazy(() => import('../chat/GalleryBlock'));
const AudioBlock = React.lazy(() => import('../chat/AudioBlock'));
const BrowserPopupBlock = React.lazy(() => import('../chat/BrowserPopupBlock'));
const BrowserLiveBlock = React.lazy(() => import('../chat/BrowserLiveBlock'));
const CadEvidenceBlock = React.lazy(() => import('../chat/CadEvidenceBlock'));

/* ── Skeleton / Fallback ── */

function BlockSkeleton({ type }: { type: string }) {
  return (
    <div className="my-2 rounded-lg border border-surface-700/40 bg-surface-900/60 p-4 animate-pulse">
      <div className="h-4 w-24 bg-surface-700/50 rounded mb-2" />
      <div className="h-32 bg-surface-700/30 rounded" />
      <span className="text-[12px] text-gray-600 mt-1 block">{type} loading…</span>
    </div>
  );
}

/** Wrapper for lazy-loaded blocks: Suspense + fade-in on mount to smooth skeleton→content swap */
function LazyBlock({ type, children }: { type: string; children: React.ReactNode }) {
  return (
    <Suspense fallback={<BlockSkeleton type={type} />}>
      <div style={{ animation: 'fade-in-block 0.25s ease-out' }}>
        {children}
      </div>
    </Suspense>
  );
}

export function BlockFallback({ raw, error }: { raw: string; error?: string }) {
  return (
    <pre className="my-2 max-w-full overflow-x-hidden whitespace-pre-wrap break-words rounded-lg border border-surface-700/40 bg-surface-900/60 p-4 text-base md:overflow-x-auto md:whitespace-pre md:break-normal">
      {error && <code className="text-sm text-red-400 block mb-2">{error}</code>}
      <code className="whitespace-pre-wrap break-words md:whitespace-pre md:break-normal">{raw}</code>
    </pre>
  );
}

/* ── File path detection ── */

/**
 * Return the `/s/<key>` target when a markdown link points at this Tower app.
 * Normal clicks should switch the active session inside the current app shell.
 * Shift-click opens it as a new Tower chat tab; cmd/ctrl/middle-click keep the
 * browser's default new-tab behavior.
 */
function towerSessionTargetFromHref(href: string): { sessionKey: string; hash: string | null } | null {
  if (typeof window === 'undefined') return null;
  try {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    const match = url.pathname.match(/^\/s\/([a-z2-9]{8}|[0-9a-f-]{36})$/i);
    return match ? { sessionKey: match[1], hash: url.hash || null } : null;
  } catch {
    return null;
  }
}

function isBrowserNewTabClick(e: React.MouseEvent): boolean {
  return e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey;
}

const INLINE_THUMBNAIL_EXTS = new Set(['pdf', 'pptx', 'ppt', 'docx', 'doc', 'hwp', 'hwpx']);

function fileExt(filePath: string): string {
  return filePath.split(/[?#]/, 1)[0].split('.').pop()?.toLowerCase() || '';
}

function isThumbnailPath(filePath: string): boolean {
  return INLINE_THUMBNAIL_EXTS.has(fileExt(filePath));
}

async function copyFilePath(filePath: string) {
  const normalizedPath = filePath.trim();
  try {
    await navigator.clipboard.writeText(normalizedPath);
    toastSuccess('위치 경로를 복사했습니다');
  } catch {
    toastError('경로 복사에 실패했습니다');
  }
}

function downloadTowerFile(filePath: string) {
  const link = document.createElement('a');
  const serveUrl = new URL(fileServeUrl(filePath), window.location.origin);
  serveUrl.searchParams.set('download', '1');
  link.href = serveUrl.toString();
  link.download = filePath.split('/').pop() || 'download';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function saveTowerFileToPersonal(filePath: string) {
  try {
    const source = await fetch(fileServeUrl(filePath));
    if (!source.ok) throw new Error('파일을 읽지 못했습니다');
    const blob = await source.blob();
    const fileName = filePath.split('/').pop() || 'saved-file';
    const form = new FormData();
    form.append('directory', 'files');
    form.append('files', new File([blob], fileName, { type: blob.type || 'application/octet-stream' }));
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const saved = await fetch('/api/personal-space/files/upload', { method: 'POST', headers, body: form });
    if (!saved.ok) {
      const body = await saved.json().catch(() => ({}));
      throw new Error(body.error || '내 파일에 저장하지 못했습니다');
    }
    toastSuccess('내 파일에 저장했습니다');
  } catch (error) {
    toastError(error instanceof Error ? error.message : '내 파일에 저장하지 못했습니다');
  }
}

function FilePathContextTarget({ filePath, children }: { filePath: string; children: React.ReactNode }) {
  const [menu, setMenu] = React.useState<{ x: number; y: number } | null>(null);

  React.useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  return (
    <>
      <span
        className="inline"
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {children}
      </span>
      {menu && typeof document !== 'undefined' && createPortal(
        <div
          role="menu"
          aria-label="파일 경로 메뉴"
          className="fixed z-[100] min-w-44 overflow-hidden rounded-lg border border-surface-700 bg-surface-900 p-1 text-[13px] text-gray-200 shadow-2xl"
          style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 196)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 260)) }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center rounded-md px-3 py-2 text-left hover:bg-surface-800"
            onClick={() => {
              openTowerFileInBrowserTab(filePath);
              setMenu(null);
            }}
          >
            새 탭에서 열기
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center rounded-md px-3 py-2 text-left hover:bg-surface-800"
            onClick={() => {
              downloadTowerFile(filePath);
              setMenu(null);
            }}
          >
            다운로드
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center rounded-md px-3 py-2 text-left hover:bg-surface-800"
            onClick={() => {
              void saveTowerFileToPersonal(filePath);
              setMenu(null);
            }}
          >
            내 파일에 저장
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center rounded-md px-3 py-2 text-left hover:bg-surface-800"
            onClick={() => {
              void copyFilePath(filePath);
              setMenu(null);
            }}
          >
            위치 경로 복사
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center rounded-md px-3 py-2 text-left hover:bg-surface-800"
            onClick={() => {
              revealTowerFileInSidebar(filePath);
              setMenu(null);
            }}
          >
            파일 위치 보기
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}

function InlineFilePreview({ filePath, onFileClick }: { filePath: string; onFileClick: (path: string) => void }) {
  const isImage = isPreviewableImageFilePath(filePath);
  const isThumb = isThumbnailPath(filePath);
  if (!isImage && !isThumb) return null;
  const src = isImage ? fileServeUrl(filePath) : fileThumbnailUrl(filePath);
  return (
    <span className={`block my-2 w-fit ${isImage ? 'max-w-[760px] md:max-w-[70%]' : 'max-w-[220px]'}`}>
      <FilePathContextTarget filePath={filePath}>
        <img
          src={src}
          alt={filePath.split('/').pop() || 'file preview'}
          loading="lazy"
          className="block h-auto max-w-full rounded-lg border border-surface-700/45 cursor-pointer bg-surface-950/40 hover:opacity-90 transition-opacity"
          onClick={(e) => {
            e.stopPropagation();
            onFileClick(filePath);
          }}
          onError={(e) => {
            (e.currentTarget.parentElement?.parentElement as HTMLElement | null)?.remove();
          }}
        />
      </FilePathContextTarget>
    </span>
  );
}

function FilePathInlineLink({ filePath, onFileClick }: { filePath: string; onFileClick: (path: string) => void }) {
  return (
    <span className="inline">
      <FilePathContextTarget filePath={filePath}>
        <span
          className="cursor-pointer underline transition-opacity hover:opacity-80"
          style={{
            color: 'var(--th-prose-link)',
            textDecorationColor: 'color-mix(in srgb, var(--th-prose-link) 40%, transparent)',
          }}
          onClick={(e) => {
            e.stopPropagation();
            onFileClick(filePath);
          }}
          title={`Open ${filePath}`}
        >
          {filePath}
        </span>
      </FilePathContextTarget>
      <InlineFilePreview filePath={filePath} onFileClick={onFileClick} />
    </span>
  );
}

/* ── Shared markdown custom components ── */

interface MdComponentsOptions {
  onFileClick?: (path: string) => void;
}

function buildMdComponents({ onFileClick }: MdComponentsOptions = {}) {
  return {
    img({ src, alt, ...props }: Record<string, any>) {
      const imgSrc = fileServeUrl(src || '');
      return (
        <img
          src={imgSrc}
          alt={alt || ''}
          loading="lazy"
          className="max-w-full rounded-lg border border-surface-700/40 cursor-pointer hover:opacity-90 transition-opacity"
          onClick={() => window.open(imgSrc, '_blank')}
          {...props}
        />
      );
    },
    code({ children, className, node: _node, ...props }: Record<string, any>) {
      const isInline = !className;
      const text = String(children).trim();
      if (isInline && onFileClick && isTowerLocalPath(text) && hasPreviewableFileExt(text)) {
        return (
          <FilePathContextTarget filePath={text}>
            <button
              {...props}
              type="button"
              className="inline cursor-pointer border-0 bg-transparent p-0 font-inherit text-inherit"
              onClick={(event) => {
                event.stopPropagation();
                onFileClick(text);
              }}
              title={`Open ${text}`}
              aria-label={`파일 열기: ${text}`}
            >
              <code className="hover:text-primary-400 transition-colors">{children}</code>
            </button>
          </FilePathContextTarget>
        );
      }
      if (!isInline) {
        return <code className={`${className || ''} whitespace-pre-wrap break-words md:whitespace-pre md:break-normal`} {...props}>{children}</code>;
      }
      return <code className={className} {...props}>{children}</code>;
    },
    // Markdown links pointing at workspace files (`[label](/home/...)` or
    // `[label](~/workspace/...)`) — without this handler react-markdown emits
    // a plain <a href="/home/..."> which the browser resolves as
    // `https://<host>/home/...` → 404. Route to the file viewer instead.
    // See: workspace/decisions/2026-05-07-workspace-file-link-policy-and-fleet-healthcheck.md
    a({ href, children, ...props }: Record<string, any>) {
      const url = String(href || '');
      const isWorkspaceFile =
        onFileClick &&
        isTowerLocalPath(url) &&
        hasPreviewableFileExt(url);
      if (isWorkspaceFile) {
        return (
          <span className="inline">
            <FilePathContextTarget filePath={url}>
              <span
                className="cursor-pointer underline transition-opacity hover:opacity-80"
                style={{
                  color: 'var(--th-prose-link)',
                  textDecorationColor: 'color-mix(in srgb, var(--th-prose-link) 40%, transparent)',
                }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onFileClick(url);
                }}
                title={`Open ${url}`}
              >
                {children}
              </span>
            </FilePathContextTarget>
            <InlineFilePreview filePath={url} onFileClick={onFileClick} />
          </span>
        );
      }
      const towerSessionTarget = towerSessionTargetFromHref(url);
      if (towerSessionTarget) {
        return (
          <a
            href={url}
            {...props}
            onClick={(e) => {
              if (isBrowserNewTabClick(e)) return;
              e.preventDefault();
              e.stopPropagation();
              window.dispatchEvent(new CustomEvent('kanban-select-session', {
                detail: {
                  sessionKey: towerSessionTarget.sessionKey,
                  hash: towerSessionTarget.hash,
                  forceNew: e.shiftKey,
                },
              }));
            }}
          >
            {children}
          </a>
        );
      }

      const isImageLink = isPreviewableImageFilePath(url);

      // External / unrecognized links — open in new tab, default styling.
      // For ordinary image URLs, also show the same inline preview users already
      // get for workspace image paths. If the URL is broken or blocked, the
      // preview removes itself and the clickable text link remains.
      return (
        <span className="inline">
          <a href={url} target="_blank" rel="noopener noreferrer" {...props}>
            {children}
          </a>
          {isImageLink && (
            <InlineFilePreview
              filePath={url}
              onFileClick={() => window.open(fileServeUrl(url), '_blank', 'noopener,noreferrer')}
            />
          )}
        </span>
      );
    },
    // Detect file paths in plain text paragraphs
    p({ children, ...props }: Record<string, any>) {
      if (!onFileClick) {
        return <p {...props}>{children}</p>;
      }
      // Process string children to find file paths
      const processed = React.Children.map(children, (child) => {
        if (typeof child !== 'string') return child;
        const parts = splitTowerFilePathsInText(child, onFileClick, (filePath, key) => (
          <FilePathInlineLink key={key} filePath={filePath} onFileClick={onFileClick} />
        ));
        return parts.length > 0 ? <>{parts}</> : child;
      });
      return <p {...props}>{processed}</p>;
    },
    pre({ children }: { children?: React.ReactNode }) {
      const codeText = extractCodeText(children);
      return (
        <pre className="relative group/code max-w-full overflow-x-hidden whitespace-pre-wrap break-words md:overflow-x-auto md:whitespace-pre md:break-normal">
          {children}
          {codeText && (
            <CopyBtn
              text={codeText}
              className="absolute top-2 right-2 opacity-60 hover:opacity-100 transition-opacity"
            />
          )}
        </pre>
      );
    },
  };
}

function extractCodeText(children: React.ReactNode): string {
  // Recursively walk to extract pure text. rehype-highlight wraps tokens in
  // <span class="hljs-*"> elements, so a code block's children is typically
  // [ReactElement, string, ReactElement, ...]. The previous one-level
  // String(props.children) coerced those nested elements to "[object Object]"
  // — which is what users saw in their clipboard.
  const walk = (node: React.ReactNode): string => {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(walk).join('');
    if (React.isValidElement(node)) {
      const props = node.props as { children?: React.ReactNode };
      return walk(props.children);
    }
    return '';
  };
  return walk(children).trim();
}

function CopyBtn({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        let ok = false;
        // Primary: async Clipboard API (requires HTTPS / secure context)
        try {
          await navigator.clipboard.writeText(text);
          ok = true;
        } catch {
          // Fallback: legacy execCommand for non-secure contexts or
          // when Clipboard permission is denied. Hidden textarea + select.
          try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.top = '0';
            ta.style.left = '0';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            ok = document.execCommand('copy');
            document.body.removeChild(ta);
          } catch {
            ok = false;
          }
        }
        if (ok) {
          toastSuccess('Copied');
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } else {
          toastError('복사 실패 — 직접 드래그해서 복사해주세요');
        }
      }}
      className={`p-1.5 rounded-md bg-surface-800/80 border border-surface-700/50 text-gray-400 hover:text-gray-200 hover:bg-surface-700/80 transition-all ${className}`}
      title="Copy"
    >
      {copied ? (
        <svg className="tone-success tone-text w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  );
}

/* ── Markdown renderer ── */

/**
 * MarkdownSegment is memoized: re-renders only when `content` changes.
 * Without React.memo, every parent re-render (e.g. each streaming token)
 * forces ReactMarkdown + remark/rehype plugin chain to re-execute on
 * already-finalized text segments — the dominant cost during streaming.
 */
const MarkdownSegment = React.memo(function MarkdownSegment({
  content,
  mdComponents,
  colorMode = 'dark',
}: { content: string; mdComponents: Record<string, any>; colorMode?: 'light' | 'dark' }) {
  return (
    <div className={`prose prose-sm min-w-0 w-full max-w-full overflow-hidden break-words ${colorMode === 'dark' ? 'prose-invert' : 'prose-slate'}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfmPlugin, [remarkMath, remarkMathOptions]]}
        rehypePlugins={[rehypeHighlight, rehypeKatex]}
        components={mdComponents}
      >
        {normalizeMarkdownEmphasisBoundaries(content)}
      </ReactMarkdown>
    </div>
  );
}, (prev, next) => prev.content === next.content && prev.mdComponents === next.mdComponents);

/* ── RichContent entry point ── */

export interface RichContentProps {
  text: string;
  onFileClick?: (path: string) => void;
  colorMode?: 'light' | 'dark';
}

/**
 * Heavy visual blocks that are expensive to mount/render.
 * While streaming, these are deferred behind a skeleton until either
 * (a) streaming ends, or (b) the block is no longer the trailing segment
 * (= the closing fence has been seen → block is "complete").
 */
const HEAVY_BLOCKS: ReadonlySet<DynamicBlock['type']> = new Set([
  'mermaid', 'chart', 'treemap', 'gallery', 'map', 'html-sandbox', 'svg',
  'browser-popup', 'browser-live',
]);

/**
 * Build a stable key for a segment based on its type + content signature.
 * Index-based keys (`key={i}`) cause React to re-mount blocks whenever
 * splitDynamicBlocks returns a different number of segments mid-stream
 * (e.g. ```chart fence appears → text becomes [text, chart]).
 * A content-derived key keeps DOM identity stable across those updates.
 */
function segmentKey(seg: DynamicBlock, i: number): string {
  const head = seg.content.length > 0 ? seg.content.slice(0, 24) : '';
  return `${i}:${seg.type}:${seg.content.length}:${head}`;
}

function isPlainJsonObjectOrArray(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const startsAsContainer =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (!startsAsContainer) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) || (parsed !== null && typeof parsed === 'object');
  } catch {
    return false;
  }
}

function PlainJsonBlock({ text }: { text: string }) {
  return (
    <pre
      aria-label="JSON response"
      className="relative group/code my-2 max-w-none overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-surface-700/45 bg-surface-950/60 p-4 text-sm leading-relaxed text-gray-100"
    >
      <code>{text.trim()}</code>
      <CopyBtn
        text={text.trim()}
        className="absolute top-2 right-2 opacity-60 hover:opacity-100 transition-opacity"
      />
    </pre>
  );
}

export function RichContent({ text, onFileClick, colorMode = 'dark' }: RichContentProps) {
  // Defensive: ensure text is always a string (streaming may pass non-string)
  const safeText = typeof text === 'string' ? text : String(text ?? '');
  const isPlainJson = useMemo(() => isPlainJsonObjectOrArray(safeText), [safeText]);
  const segments = useMemo(() => splitDynamicBlocks(safeText), [safeText]);
  const mdComponents = useMemo(() => buildMdComponents({ onFileClick }), [onFileClick]);
  const isStreaming = useActiveSessionStreaming();

  if (isPlainJson) {
    return <PlainJsonBlock text={safeText} />;
  }

  return (
    <>
      {segments.map((seg, i) => {
        // Heavy blocks: defer mounting if this is the LAST segment AND streaming is on.
        // Once a closing fence appears, splitDynamicBlocks pushes a new trailing
        // text segment after the heavy block — at that point the heavy block
        // is "frozen" and safe to render immediately.
        const isLast = i === segments.length - 1;
        const deferHeavy = isStreaming && isLast && HEAVY_BLOCKS.has(seg.type);
        return (
          <RichSegment
            key={segmentKey(seg, i)}
            seg={seg}
            mdComponents={mdComponents}
            onFileClick={onFileClick}
            deferHeavy={deferHeavy}
            colorMode={colorMode}
          />
        );
      })}
    </>
  );
}

const RichSegment = React.memo(function RichSegment({
  seg,
  mdComponents,
  onFileClick,
  deferHeavy,
  colorMode,
}: { seg: DynamicBlock; mdComponents: Record<string, any>; onFileClick?: (path: string) => void; deferHeavy?: boolean; colorMode: 'light' | 'dark' }) {
  if (deferHeavy && HEAVY_BLOCKS.has(seg.type)) {
    return <BlockSkeleton type={seg.type} />;
  }
  return <RichSegmentInner seg={seg} mdComponents={mdComponents} onFileClick={onFileClick} colorMode={colorMode} />;
}, (prev, next) =>
  prev.deferHeavy === next.deferHeavy &&
  prev.colorMode === next.colorMode &&
  prev.mdComponents === next.mdComponents &&
  prev.onFileClick === next.onFileClick &&
  prev.seg.type === next.seg.type &&
  prev.seg.content === next.seg.content
);

function RichSegmentInner({ seg, mdComponents, onFileClick, colorMode }: { seg: DynamicBlock; mdComponents: Record<string, any>; onFileClick?: (path: string) => void; colorMode: 'light' | 'dark' }) {
  if (seg.type === 'text') {
    return <MarkdownSegment content={seg.content} mdComponents={mdComponents} colorMode={colorMode} />;
  }
  if (seg.type === 'mermaid') {
    return <LazyBlock type="mermaid"><MermaidBlock code={seg.content} /></LazyBlock>;
  }
  if (seg.type === 'chart') {
    return <LazyBlock type="chart"><ChartBlock raw={seg.content} fallbackCode={seg.raw} /></LazyBlock>;
  }
  if (seg.type === 'secure-input') {
    return <LazyBlock type="secure-input"><SecureInputBlock raw={seg.content} fallbackCode={seg.raw} /></LazyBlock>;
  }
  if (seg.type === 'datatable') {
    return <LazyBlock type="datatable"><DataTableBlock raw={seg.content} fallbackCode={seg.raw} /></LazyBlock>;
  }
  if (seg.type === 'html-sandbox') {
    return <LazyBlock type="html-sandbox"><HtmlSandboxBlock raw={seg.content} fallbackCode={seg.raw} /></LazyBlock>;
  }
  if (seg.type === 'svg') {
    return <LazyBlock type="svg"><SvgBlock raw={seg.content} fallbackCode={seg.raw} /></LazyBlock>;
  }
  if (seg.type === 'timeline') {
    return <LazyBlock type="timeline"><TimelineBlock raw={seg.content} fallbackCode={seg.raw} /></LazyBlock>;
  }
  if (seg.type === 'map') {
    return <LazyBlock type="map"><MapBlock raw={seg.content} fallbackCode={seg.raw} /></LazyBlock>;
  }
  if (seg.type === 'steps') {
    return <LazyBlock type="steps"><StepsBlock raw={seg.content} fallbackCode={seg.raw} /></LazyBlock>;
  }
  if (seg.type === 'diff') {
    return <LazyBlock type="diff"><DiffBlock raw={seg.content} fallbackCode={seg.raw} /></LazyBlock>;
  }
  if (seg.type === 'form') {
    return <LazyBlock type="form"><FormBlock raw={seg.content} fallbackCode={seg.raw} /></LazyBlock>;
  }
  if (seg.type === 'kanban') {
    return <LazyBlock type="kanban"><KanbanBlock raw={seg.content} fallbackCode={seg.raw} /></LazyBlock>;
  }
  if (seg.type === 'terminal') {
    return <LazyBlock type="terminal"><TerminalBlock raw={seg.content} fallbackCode={seg.raw} onFileClick={onFileClick} /></LazyBlock>;
  }
  if (seg.type === 'comparison') {
    return <LazyBlock type="comparison"><ComparisonBlock raw={seg.content} fallbackCode={seg.raw} /></LazyBlock>;
  }
  if (seg.type === 'treemap') {
    return <LazyBlock type="treemap"><TreemapBlock raw={seg.content} fallbackCode={seg.raw} /></LazyBlock>;
  }
  if (seg.type === 'gallery') {
    return <LazyBlock type="gallery"><GalleryBlock raw={seg.content} fallbackCode={seg.raw} /></LazyBlock>;
  }
  if (seg.type === 'audio') {
    return <LazyBlock type="audio"><AudioBlock raw={seg.content} fallbackCode={seg.raw} /></LazyBlock>;
  }
  if (seg.type === 'browser-popup') {
    return <LazyBlock type="browser-popup"><BrowserPopupBlock raw={seg.content} fallbackCode={seg.raw} /></LazyBlock>;
  }
  if (seg.type === 'browser-live') {
    return <LazyBlock type="browser-live"><BrowserLiveBlock raw={seg.content} fallbackCode={seg.raw} /></LazyBlock>;
  }
  if (seg.type === 'cad-evidence') {
    return <LazyBlock type="cad-evidence"><CadEvidenceBlock raw={seg.content} fallbackCode={seg.raw} /></LazyBlock>;
  }
  return <BlockFallback raw={seg.raw} error={`${seg.type} renderer not yet available`} />;
}

export { BlockSkeleton };

// ── Preload frequently-used chunks after initial page render ──
// These blocks appear in most AI conversations. Loading them eagerly in background
// eliminates the Suspense flash when scrolling into messages that contain them.
// Rare blocks (map, gallery, browser-*) remain fully lazy.
if (typeof window !== 'undefined' && import.meta.env.MODE !== 'test') {
  const scheduleIdle = typeof requestIdleCallback === 'function' ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 2000);
  scheduleIdle(() => {
    import('../chat/ChartBlock');
    import('../chat/DataTableBlock');
    import('../chat/TimelineBlock');
    import('../chat/StepsBlock');
    import('../chat/DiffBlock');
    import('../chat/ComparisonBlock');
    import('../chat/TerminalBlock');
    import('../chat/KanbanBlock');
  });
}
