import { towerHttpUrl } from '../../features/client-connection/connection';
import { KeepDashboard } from '../interactive-apps/KeepDashboard';
import { PricingFilePreview, isPricingAppFile } from '../interactive-apps/PricingFilePreview';
import { FileOperationFeedback } from '../../features/file-operation-feedback/FileOperationFeedback';
import { saveScope } from '../../features/file-operation-feedback/feedback';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFileStore } from '../../stores/file-store';
import { useConfirm } from '../../hooks/useDialog';
import { useScrollMemory } from '../../hooks/useScrollMemory';
import { TabBar } from '../files/TabBar';
import { MarkdownReadSurface } from '../files/MarkdownReadSurface';
import { FileActionsMenu } from '../files/FileActionsMenu';

import { AgentDraftPreview } from '../files/AgentDraftPreview';
import { shouldUseFileBodySelectAll, selectElementTextContents } from '../files/fileSelection';
import { useSettingsStore } from '../../stores/settings-store';
import { buildPdfServeUrl } from '../../utils/pdf-open';

// Conditional viewer surfaces stay out of the initial chat shell.
const LazyShareModal = React.lazy(() => import('../files/ShareModal').then(module => ({ default: module.ShareModal })));
const LazyHtmlPreviewSurface = React.lazy(() => import('../files/HtmlPreviewSurface').then(module => ({ default: module.HtmlPreviewSurface })));
const LazyUrlPreviewSurface = React.lazy(() => import('../files/UrlPreviewSurface').then(module => ({ default: module.UrlPreviewSurface })));
const LazyOpenUrlPreviewDialog = React.lazy(() => import('../files/OpenUrlPreviewDialog').then(module => ({ default: module.OpenUrlPreviewDialog })));
const LazyPersonalTodoView = React.lazy(() => import('../personal-space/PersonalTodoView').then(module => ({ default: module.PersonalTodoView })));
const LazyPersonalMaterialsView = React.lazy(() => import('../personal-space/PersonalMaterialsView').then(module => ({ default: module.PersonalMaterialsView })));
const LazyPersonalArchiveView = React.lazy(() => import('../personal-space/PersonalArchiveView').then(module => ({ default: module.PersonalArchiveView })));
const LazyMobilePersonalDocumentsView = React.lazy(() => import('../personal-space/MobilePersonalDocumentsView').then(module => ({ default: module.MobilePersonalDocumentsView })));

// Lazy-loaded Office preview components
const DocxPreview = React.lazy(() => import('../files/DocxPreview').then(m => ({ default: m.DocxPreview })));
const XlsxPreview = React.lazy(() => import('../files/XlsxPreview').then(m => ({ default: m.XlsxPreview })));
const PptxPreview = React.lazy(() => import('../files/PptxPreview').then(m => ({ default: m.PptxPreview })));
const HwpPreview = React.lazy(() => import('../files/HwpPreview').then(m => ({ default: m.HwpPreview })));
const SqlitePreview = React.lazy(() => import('../files/SqlitePreview').then(m => ({ default: m.SqlitePreview })));
const CadPreview = React.lazy(() => import('../files/CadPreview').then(m => ({ default: m.CadPreview })));
const LazyCodeEditor = React.lazy(() => import('../editor/CodeEditor').then(m => ({ default: m.CodeEditor })));
const LazyMarkdownEditor = React.lazy(() => import('../files/markdown-editor/MarkdownEditor').then(m => ({ default: m.MarkdownEditor })));
const LazyMarkdownTtsControls = React.lazy(() => import('../files/MarkdownTtsControls').then(m => ({ default: m.MarkdownTtsControls })));
const LazyMarkdownPreviewSurface = React.lazy(() => import('../files/MarkdownPreviewSurface').then(m => ({ default: m.MarkdownPreviewSurface })));
const LazyHtmlDirectEditSurface = React.lazy(() => import('../files/HtmlDirectEditSurface').then(m => ({ default: m.HtmlDirectEditSurface })));

function FeatureLoading({ i18nKey = 'loadingFeature' }: { i18nKey?: string }) {
  const { t } = useTranslation('layout');
  return <div className="flex h-full min-h-24 items-center justify-center text-sm text-surface-500">{t(i18nKey)}</div>;
}

function deferredSurface<T extends React.ComponentType<any>>(Component: T) {
  return function DeferredSurface(props: React.ComponentProps<T>) {
    return <React.Suspense fallback={<FeatureLoading />}><Component {...props} /></React.Suspense>;
  };
}

const ShareModal = deferredSurface(LazyShareModal);
const HtmlPreviewSurface = deferredSurface(LazyHtmlPreviewSurface);
const UrlPreviewSurface = deferredSurface(LazyUrlPreviewSurface);
const OpenUrlPreviewDialog = deferredSurface(LazyOpenUrlPreviewDialog);
const PersonalTodoView = deferredSurface(LazyPersonalTodoView);
const PersonalMaterialsView = deferredSurface(LazyPersonalMaterialsView);
const PersonalArchiveView = deferredSurface(LazyPersonalArchiveView);
const MobilePersonalDocumentsView = deferredSurface(LazyMobilePersonalDocumentsView);

function CodeEditor(props: React.ComponentProps<typeof LazyCodeEditor>) {
  return <React.Suspense fallback={<FeatureLoading i18nKey="loadingEditor" />}><LazyCodeEditor {...props} /></React.Suspense>;
}
function MarkdownEditor(props: React.ComponentProps<typeof LazyMarkdownEditor>) {
  return <React.Suspense fallback={<FeatureLoading i18nKey="loadingMarkdownEditor" />}><LazyMarkdownEditor {...props} /></React.Suspense>;
}
function MarkdownTtsControls(props: React.ComponentProps<typeof LazyMarkdownTtsControls>) {
  return <React.Suspense fallback={<span className={props.className} aria-hidden="true" />}><LazyMarkdownTtsControls {...props} /></React.Suspense>;
}
function MarkdownPreviewSurface(props: React.ComponentProps<typeof LazyMarkdownPreviewSurface>) {
  return <React.Suspense fallback={<FeatureLoading i18nKey="loadingQuickEdit" />}><LazyMarkdownPreviewSurface {...props} /></React.Suspense>;
}
function HtmlDirectEditSurface(props: React.ComponentProps<typeof LazyHtmlDirectEditSurface>) {
  return <React.Suspense fallback={<FeatureLoading i18nKey="loadingHtmlEditor" />}><LazyHtmlDirectEditSurface {...props} /></React.Suspense>;
}
const OFFICE_FORMATS = new Set(['docx', 'xlsx', 'pptx', 'hwp']);
const TEXT_PREVIEW_FORMATS = new Set(['text', 'csv']);
const CODE_PREVIEW_FORMATS = new Set(['json', 'yaml', 'javascript', 'typescript', 'jsx', 'tsx', 'python', 'html', 'css']);

type SimpleDiffLine = { kind: 'same' | 'remove' | 'add'; text: string };
type DiffHunk = { id: number; beforeStart: number; beforeEnd: number; afterLines: string[]; lines: SimpleDiffLine[] };

function splitLinesPreserveTrailingNewline(value: string): string[] {
  if (value === '') return [];
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function joinLinesPreserveFinalNewline(lines: string[], reference: string): string {
  if (lines.length === 0) return reference.endsWith('\n') ? '\n' : '';
  return `${lines.join('\n')}${reference.endsWith('\n') ? '\n' : ''}`;
}

function simpleLineDiff(before: string, after: string): SimpleDiffLine[] {
  const a = splitLinesPreserveTrailingNewline(before);
  const b = splitLinesPreserveTrailingNewline(after);
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: SimpleDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'remove', text: a[i] });
      i += 1;
    } else {
      out.push({ kind: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) out.push({ kind: 'remove', text: a[i++] });
  while (j < b.length) out.push({ kind: 'add', text: b[j++] });
  return out;
}

function diffHunks(before: string, after: string): DiffHunk[] {
  const diff = simpleLineDiff(before, after);
  const hunks: DiffHunk[] = [];
  let beforeIndex = 0;
  let current: DiffHunk | null = null;
  for (const line of diff) {
    if (line.kind === 'same') {
      if (current) {
        hunks.push(current);
        current = null;
      }
      beforeIndex += 1;
      continue;
    }
    if (!current) current = { id: hunks.length, beforeStart: beforeIndex, beforeEnd: beforeIndex, afterLines: [], lines: [] };
    current.lines.push(line);
    if (line.kind === 'remove') {
      beforeIndex += 1;
      current.beforeEnd = beforeIndex;
    } else {
      current.afterLines.push(line.text);
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

function applyDiffHunk(content: string, hunk: DiffHunk): string {
  const lines = splitLinesPreserveTrailingNewline(content);
  const next = [...lines.slice(0, hunk.beforeStart), ...hunk.afterLines, ...lines.slice(hunk.beforeEnd)];
  return joinLinesPreserveFinalNewline(next, content);
}

function getPreviewRevision(content: string, encoding?: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i += 1) {
    hash = ((hash << 5) + hash) ^ content.charCodeAt(i);
  }
  return `${encoding ?? 'text'}:${content.length}:${hash >>> 0}`;
}

function PdfPreview({ filePath, revision, active = true }: { filePath: string; revision: string; active?: boolean }) {
  const src = buildPdfServeUrl(filePath, { revision });
  const containerClassName = active ? 'absolute inset-0' : 'hidden';

  return (
    <div className={`${containerClassName} min-h-0 bg-surface-950`}>
      <iframe
        src={src}
        title={filePath.split('/').pop() || 'document.pdf'}
        className="h-full w-full border-0 bg-white"
      />
    </div>
  );
}

// Keep opened PDFs mounted so switching Viewer tabs preserves the native PDF
// viewer's page and zoom state without opening or reusing browser tabs.
function PdfPreviewCache({ activeFile }: { activeFile: { path: string; revision: string } | null }) {
  const allTabs = useFileStore((s) => s.tabs);
  const pdfTabs = useMemo(
    () => allTabs.filter((t) => t.language === 'pdf').map((t) => ({ path: t.path, revision: getPreviewRevision(t.content, t.encoding) })),
    [allTabs],
  );
  const [cachedKeys, setCachedKeys] = useState<string[]>([]);
  const activeKey = activeFile ? `${activeFile.revision}:${activeFile.path}` : null;

  useEffect(() => {
    if (!activeKey) return;
    setCachedKeys((prev) => (prev.includes(activeKey) ? prev : [...prev, activeKey]));
  }, [activeKey]);

  const openPdfByKey = useMemo<Map<string, { path: string; revision: string }>>(() => {
    const entries: [string, { path: string; revision: string }][] = pdfTabs.map((tab) => [`${tab.revision}:${tab.path}`, tab]);
    if (activeFile) entries.push([`${activeFile.revision}:${activeFile.path}`, activeFile]);
    return new Map(entries);
  }, [activeFile, pdfTabs]);
  const renderKeys = cachedKeys.filter((key) => openPdfByKey.has(key));

  return (
    <>
      {renderKeys.map((key) => {
        const item = openPdfByKey.get(key)!;
        return <PdfPreview key={key} filePath={item.path} revision={item.revision} active={key === activeKey} />;
      })}
    </>
  );
}

type OfficePreviewLanguage = 'docx' | 'xlsx' | 'pptx' | 'hwp';
const MAX_MOUNTED_OFFICE_PREVIEWS = 2;

function OfficePreviewCache({ activeFile }: { activeFile: { path: string; language: OfficePreviewLanguage; revision: string } | null }) {
  const { t } = useTranslation('layout');
  const allTabs = useFileStore((s) => s.tabs);
  const officeTabs = useMemo(
    () => allTabs
      .filter((t): t is typeof t & { language: OfficePreviewLanguage } => OFFICE_FORMATS.has(t.language))
      .map((t) => ({ path: t.path, language: t.language, revision: getPreviewRevision(t.content, t.encoding) })),
    [allTabs],
  );
  const [cachedKeys, setCachedKeys] = useState<string[]>([]);
  const activeKey = activeFile ? `${activeFile.language}:${activeFile.revision}:${activeFile.path}` : null;

  useEffect(() => {
    if (!activeKey) return;
    setCachedKeys((prev) => {
      const next = prev.filter((key) => key !== activeKey);
      next.push(activeKey);
      return next.slice(-MAX_MOUNTED_OFFICE_PREVIEWS);
    });
  }, [activeKey]);

  const openOfficeByKey = useMemo<Map<string, { path: string; language: OfficePreviewLanguage; revision: string }>>(() => {
    const entries: [string, { path: string; language: OfficePreviewLanguage; revision: string }][] = officeTabs.map((tab) => [`${tab.language}:${tab.revision}:${tab.path}`, tab]);
    if (activeFile) entries.push([`${activeFile.language}:${activeFile.revision}:${activeFile.path}`, activeFile]);
    return new Map(entries);
  }, [activeFile, officeTabs]);
  const renderKeys = cachedKeys.filter((key) => openOfficeByKey.has(key));

  return (
    <>
      {renderKeys.map((key) => {
        const item = openOfficeByKey.get(key)!;
        const isActive = key === activeKey;
        return (
          <div key={key} className={isActive ? 'absolute inset-0 flex flex-col' : 'hidden'}>
            <React.Suspense fallback={
              <div className="flex items-center justify-center h-full text-gray-400 text-base">
                <svg className="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                {t('loadingViewer')}
              </div>
            }>
              {item.language === 'docx' && <DocxPreview filePath={item.path} cacheKey={item.revision} />}
              {item.language === 'xlsx' && <XlsxPreview filePath={item.path} cacheKey={item.revision} />}
              {item.language === 'pptx' && <PptxPreview filePath={item.path} cacheKey={item.revision} />}
              {item.language === 'hwp' && <HwpPreview filePath={item.path} cacheKey={item.revision} />}
            </React.Suspense>
          </div>
        );
      })}
    </>
  );
}

function ImagePreview({ filePath }: { filePath: string }) {
  const { t } = useTranslation('layout');
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setStatus('loading');
    setBlobUrl(null);
    const token = localStorage.getItem('token') || '';
    fetch(towerHttpUrl(`/api/files/serve?path=${encodeURIComponent(filePath)}`), {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
        setStatus('loaded');
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[ImagePreview] load failed:', filePath, err.message);
        setStatus('error');
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [filePath]);

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-surface-900 p-4 overflow-auto">
      {status === 'loading' && (
        <span className="absolute text-gray-500 text-base">{t('loadingImage')}</span>
      )}
      {status === 'error' && (
        <span className="text-red-400 text-base">{t('imageLoadFailed')}</span>
      )}
      {blobUrl && (
        <img
          src={blobUrl}
          alt={filePath.split('/').pop()}
          className="max-w-full max-h-full object-contain"
        />
      )}
    </div>
  );
}

function VideoPreview({ filePath }: { filePath: string }) {
  const { t } = useTranslation('layout');
  const token = localStorage.getItem('token') || '';
  const src = towerHttpUrl(`/api/files/serve?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(token)}`);
  const fileName = filePath.split('/').pop() || 'video';
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black p-4">
      <video src={src} controls preload="metadata" playsInline className="max-w-full max-h-full min-h-0" />
      <a
        href={`${src}&download=1`}
        download={fileName}
        className="text-sm text-gray-400 hover:text-gray-200 underline underline-offset-4"
      >
        {t('downloadVideo')}
      </a>
    </div>
  );
}

interface ContextPanelProps {
  onSave?: (path: string, content: string) => void;
  onReload?: (path: string) => void;
  onRenamePersonalFile?: (path: string, title: string) => Promise<void>;
  onMobileClose?: () => void;
  /** When true, hides expand/collapse button (already full-screen in files view) */
  fullScreen?: boolean;
  /** Navigate to a file (used by markdown link clicks) */
  onFileNavigate?: (path: string) => void;
  /**
   * When true, hide the internal TabBar — used when ContextPanel is embedded
   * in the main body (a global FileTabBar already shows the tabs above).
   * See: workspace/decisions/2026-05-22-global-multi-tab-shell.md (v2)
   */
  hideTabBar?: boolean;
  /** Render this file tab instead of the active main tab; used by IDE-style split panes. */
  tabId?: string;
}

export function ContextPanel({ onSave, onReload, onRenamePersonalFile, onMobileClose, fullScreen, onFileNavigate, hideTabBar, tabId }: ContextPanelProps) {
  const { t } = useTranslation('layout');
  const confirm = useConfirm();
  const previewDirectEditEnabled = useSettingsStore((s) => s.serverConfig?.previewDirectEditEnabled === true);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState('');
  const [latestDiskContent, setLatestDiskContent] = useState<string | null>(null);
  const [screenPreviewPath, setScreenPreviewPath] = useState<string | null>(null);
  const [urlPreviewDialogOpen, setUrlPreviewDialogOpen] = useState(false);
  const confirmCloseModified = useCallback(async (): Promise<boolean> => {
    return await confirm({
      title: t('unsavedChangesTitle'),
      message: t('unsavedChangesCloseMessage'),
      confirmLabel: t('common:close'),
      danger: true,
    });
  }, [confirm, t]);
  const activeOpenFile = useFileStore((s) => s.openFile);
  const activeTabId = useFileStore((s) => s.activeTabId);
  const paneTab = useFileStore((s) => {
    const targetId = tabId ?? s.activeTabId;
    return targetId ? s.tabs.find(t => t.id === targetId) ?? null : null;
  });
  const openFile = paneTab
    ? { path: paneTab.path, content: paneTab.content, language: paneTab.language, modified: paneTab.modified, encoding: paneTab.encoding }
    : tabId || activeTabId ? null : activeOpenFile;
  const compareDiff = useMemo(() => latestDiskContent == null || !openFile ? [] : simpleLineDiff(openFile.content, latestDiskContent), [latestDiskContent, openFile]);
  const compareHunks = useMemo(() => latestDiskContent == null || !openFile ? [] : diffHunks(openFile.content, latestDiskContent), [latestDiskContent, openFile]);
  const contextPanelTab = useFileStore((s) => s.contextPanelTab);
  const setContextPanelTab = useFileStore((s) => s.setContextPanelTab);
  const updateOpenFileContent = useFileStore((s) => s.updateOpenFileContent);
  const updateTabContent = useFileStore((s) => s.updateTabContent);
  const updateContent = useCallback((content: string) => {
    const targetId = tabId ?? activeTabId;
    if (targetId) updateTabContent(targetId, content);
    else updateOpenFileContent(content);
  }, [activeTabId, tabId, updateOpenFileContent, updateTabContent]);
  const externalChange = useFileStore((s) => s.externalChange);
  const keepLocalEdits = useFileStore((s) => s.keepLocalEdits);
  const contextPanelExpanded = useFileStore((s) => s.contextPanelExpanded);
  const setContextPanelExpanded = useFileStore((s) => s.setContextPanelExpanded);

  // Per-user × per-path scroll memory. Three wirings — each viewer 의 *진짜*
  // 스크롤 요소가 다른 곳에 있어서:
  //   markdown: outer div (#md-scroll-container) 가 스크롤러
  //   code:     CodeMirror 가 내부에 .cm-scroller 를 만들어 거기서 스크롤
  //   html:     sandboxed iframe 의 contentDocument.scrollingElement
  // PDF (브라우저 native viewer) / image / video / docx 등은 자체 뷰어가 내장이라
  // 현재 미지원. resolver 가 null 반환하면 hook 은 조용히 no-op.
  // 결정: workspace/decisions/2026-05-22-global-multi-tab-shell.md (§ v3 후속)
  const mdScrollRef = useRef<HTMLDivElement>(null);
  const mdSelectableRef = useRef<HTMLDivElement>(null);
  const textSelectableRef = useRef<HTMLPreElement>(null);
  const codeWrapRef = useRef<HTMLDivElement>(null);
  const htmlWrapRef = useRef<HTMLDivElement>(null);
  const currentPath = openFile?.path ?? null;
  const isScreenPreviewCode = openFile?.language === 'tsx' || openFile?.language === 'jsx';
  const screenPreviewStorageKey = currentPath ? `tower.screenPreviewUrl:${currentPath}` : null;
  const screenPreviewUrl = screenPreviewStorageKey ? localStorage.getItem(screenPreviewStorageKey) : null;
  const screenPreviewActive = isScreenPreviewCode && screenPreviewPath === currentPath && !!screenPreviewUrl;
  const contentRevision = `${openFile?.path ?? ''}:${openFile?.content.length ?? 0}:${openFile?.content.slice(0, 64) ?? ''}`;
  const [cachedMarkdownPaths, setCachedMarkdownPaths] = useState<string[]>([]);
  const [showShareModal, setShowShareModal] = useState(false);
  const isMobilePersonalDocumentsView = openFile?.path === 'personal://documents';
  const isPersonalMaterialsView = openFile?.path === 'personal://materials';
  const isPersonalTodoView = openFile?.path === 'personal://todos';
  const isPersonalArchiveView = openFile?.path === 'personal://archive';
  const isPersonalFile = openFile?.path.startsWith('personal://') === true && !isMobilePersonalDocumentsView && !isPersonalTodoView && !isPersonalMaterialsView && !isPersonalArchiveView;
  const personalFileTitle = isPersonalFile && openFile
    ? decodeURIComponent(openFile.path.split('/').pop() || '').replace(/\.md$/i, '')
    : '';
  const [titleDraft, setTitleDraft] = useState(personalFileTitle);
  const [renamingTitle, setRenamingTitle] = useState(false);
  useEffect(() => setTitleDraft(personalFileTitle), [personalFileTitle]);
  const commitPersonalTitle = useCallback(async () => {
    if (!isPersonalFile || !openFile || !onRenamePersonalFile) return;
    const nextTitle = titleDraft.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ');
    if (!nextTitle || nextTitle === personalFileTitle) {
      setTitleDraft(personalFileTitle);
      return;
    }
    setRenamingTitle(true);
    try {
      await onRenamePersonalFile(openFile.path, nextTitle);
    } finally {
      setRenamingTitle(false);
    }
  }, [isPersonalFile, onRenamePersonalFile, openFile, personalFileTitle, titleDraft]);
  useScrollMemory(() => mdScrollRef.current, currentPath);
  useScrollMemory(
    () => (codeWrapRef.current?.querySelector('.cm-scroller') as HTMLElement | null) ?? null,
    currentPath,
  );
  useScrollMemory(() => {
    const iframe = htmlWrapRef.current?.querySelector('iframe') as HTMLIFrameElement | null;
    try {
      return (iframe?.contentDocument?.scrollingElement as HTMLElement | null) ?? null;
    } catch {
      // Cross-origin (e.g., sandbox without allow-same-origin) → silently skip.
      return null;
    }
  }, currentPath);
  const tabs = useFileStore((s) => s.tabs);
  const markdownTabsByPath = useMemo(() => new Map(tabs.filter((t) => t.language === 'markdown').map((t) => [t.path, t])), [tabs]);
  const activeMarkdownPath = openFile?.language === 'markdown' ? openFile.path : null;
  const markdownPreviewPaths = cachedMarkdownPaths.filter((path) => markdownTabsByPath.has(path) || path === activeMarkdownPath);
  const navHistory = useFileStore((s) => s.navHistory);
  const navIndex = useFileStore((s) => s.navIndex);
  const handlePreviewDirectEditChange = useCallback(
    (next: string) => updateContent(next),
    [updateContent],
  );

  const handleNavBack = useCallback(() => {
    const path = useFileStore.getState().navBack();
    if (path && onFileNavigate) {
      const fs = useFileStore.getState();
      const existingTab = fs.tabs.find(t => t.path === path);
      if (existingTab) {
        if (fs.activeFilePane === 'extra' && fs.splitTabId) {
          fs.openSplitTab(existingTab.id, fs.splitOrientation);
        } else {
          fs.setActiveTab(existingTab.id);
        }
      } else {
        onFileNavigate(path);
      }
    }
  }, [onFileNavigate]);

  const handleNavForward = useCallback(() => {
    const path = useFileStore.getState().navForward();
    if (path && onFileNavigate) {
      const fs = useFileStore.getState();
      const existingTab = fs.tabs.find(t => t.path === path);
      if (existingTab) {
        if (fs.activeFilePane === 'extra' && fs.splitTabId) {
          fs.openSplitTab(existingTab.id, fs.splitOrientation);
        } else {
          fs.setActiveTab(existingTab.id);
        }
      } else {
        onFileNavigate(path);
      }
    }
  }, [onFileNavigate]);

  useEffect(() => {
    if (openFile && ['markdown', 'html', 'agent-draft', 'pdf', 'image', 'video', 'docx', 'xlsx', 'pptx', 'hwp', 'sqlite', 'cad', 'text', 'csv', ...CODE_PREVIEW_FORMATS].includes(openFile.language)) {
      setContextPanelTab('preview');
    }
  }, [openFile?.path]);

  useEffect(() => {
    if (!activeMarkdownPath) return;
    setCachedMarkdownPaths((prev) => (prev.includes(activeMarkdownPath) ? prev : [...prev, activeMarkdownPath]));
  }, [activeMarkdownPath]);

  // Keyboard shortcuts: Ctrl+W close tab, Ctrl+Tab/Ctrl+Shift+Tab switch tabs
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const state = useFileStore.getState();
      if (state.tabs.length === 0) return;

      // Ctrl+W: close current tab
      if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
        e.preventDefault();
        if (state.activeTabId) {
          const tab = state.tabs.find(t => t.id === state.activeTabId);
          const tabId = state.activeTabId;
          if (tab?.modified) {
            // Async confirm — close the tab only after the user accepts.
            void (async () => {
              if (await confirmCloseModified()) state.closeTab(tabId);
            })();
          } else {
            state.closeTab(tabId);
          }
        }
        return;
      }

      // Ctrl+Tab / Ctrl+Shift+Tab: next/prev tab
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        const idx = state.tabs.findIndex(t => t.id === state.activeTabId);
        if (idx === -1) return;
        const nextIdx = e.shiftKey
          ? (idx - 1 + state.tabs.length) % state.tabs.length
          : (idx + 1) % state.tabs.length;
        state.setActiveTab(state.tabs[nextIdx].id);
        return;
      }

      // Alt+← / Alt+→: back/forward navigation
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        if (e.key === 'ArrowLeft') {
          handleNavBack();
        } else {
          handleNavForward();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleNavBack, handleNavForward, confirmCloseModified]);

  const handleClose = useCallback(async () => {
    const fs = useFileStore.getState();
    if (tabId) {
      const tab = fs.tabs.find(t => t.id === tabId);
      if (tab?.modified && !(await confirmCloseModified())) return;
      fs.closeSplitTab();
      return;
    }
    if (fullScreen) {
      // Files view: close the active main tab
      const { activeTabId, closeTab, tabs: currentTabs } = fs;
      if (activeTabId) {
        const tab = currentTabs.find(t => t.id === activeTabId);
        if (tab?.modified && !(await confirmCloseModified())) return;
        closeTab(activeTabId);
      }
    } else {
      // Side panel (chat view): just hide the panel, keep tabs alive
      fs.setContextPanelOpen(false);
    }
  }, [fullScreen, tabId, confirmCloseModified]);

  const handleSave = useCallback((nextContent = openFile?.content) => {
    if (openFile && onSave && nextContent != null) {
      onSave(openFile.path, nextContent);
    }
  }, [openFile, onSave]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (openFile?.modified) handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openFile?.modified, handleSave]);

  // In rendered file previews, Mod+A should copy the document body — not the
  // Tower header, global tab strip, or session sidebar. Raw/edit modes keep
  // CodeMirror/contenteditable native select-all behavior.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const state = useFileStore.getState();
      const isThisActivePane = tabId
        ? state.activeFilePane === 'extra' && state.splitTabId === tabId
        : state.activeFilePane === 'main';
      if (!isThisActivePane) return;

      const language = openFile?.language;
      const selectableRoot = contextPanelTab === 'preview'
        ? language === 'markdown'
          ? mdSelectableRef.current
          : language && TEXT_PREVIEW_FORMATS.has(language)
            ? textSelectableRef.current
            : null
        : null;

      if (!shouldUseFileBodySelectAll(e, selectableRoot)) return;
      e.preventDefault();
      selectElementTextContents(selectableRoot);
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [contextPanelTab, openFile?.language, openFile?.path, tabId]);

  const handleReload = useCallback(() => {
    if (openFile && onReload) {
      onReload(openFile.path);
    }
  }, [openFile, onReload]);

  const handleCompareLatest = useCallback(async () => {
    if (!openFile) return;
    setCompareOpen(true);
    setCompareLoading(true);
    setCompareError('');
    try {
      const token = localStorage.getItem('token');
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const endpoint = openFile.path.startsWith('personal://')
        ? `/api/personal-space/files/read?uri=${encodeURIComponent(openFile.path)}`
        : `/api/files/read?path=${encodeURIComponent(openFile.path)}`;
      const res = await fetch(endpoint, { headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('fileReloadFailedWithStatus', { status: res.status }));
      setLatestDiskContent(typeof data.content === 'string' ? data.content : '');
    } catch (err) {
      setCompareError(err instanceof Error ? err.message : t('fileReloadFailed'));
      setLatestDiskContent(null);
    } finally {
      setCompareLoading(false);
    }
  }, [openFile, t]);

  const acceptLatestDiskContent = useCallback(() => {
    if (latestDiskContent == null) return;
    useFileStore.getState().reloadFromDisk(latestDiskContent);
    setCompareOpen(false);
    setLatestDiskContent(null);
  }, [latestDiskContent]);

  const acceptDiffHunk = useCallback((hunk: DiffHunk) => {
    if (!openFile) return;
    const next = applyDiffHunk(openFile.content, hunk);
    updateContent(next);
  }, [openFile, updateContent]);

  // Resolve relative paths against the open file's directory
  const resolveRelativePath = useCallback((href: string, baseDir: string): string => {
    let resolvedPath: string;
    if (href.startsWith('/')) {
      resolvedPath = href;
    } else {
      resolvedPath = baseDir + '/' + href;
    }
    const parts = resolvedPath.split('/');
    const normalized: string[] = [];
    for (const p of parts) {
      if (p === '..') normalized.pop();
      else if (p !== '.') normalized.push(p);
    }
    return normalized.join('/');
  }, []);

  // Navigate to a file with fallback: try current dir first, then parent dirs up to project root
  const navigateToFile = useCallback(async (href: string, fileDir: string) => {
    if (!onFileNavigate) return;

    // Build candidate paths: current dir, parent dir, grandparent...
    const candidates: string[] = [];
    const primaryPath = resolveRelativePath(href, fileDir);
    candidates.push(primaryPath);

    // If the href has no directory component (just a filename), try parent directories
    if (!href.includes('/') || href.startsWith('./')) {
      const cleanHref = href.replace(/^\.\//, '');
      let dir = fileDir;
      // Walk up to 3 levels (e.g., wiki/ → project root)
      for (let i = 0; i < 3; i++) {
        const parentDir = dir.substring(0, dir.lastIndexOf('/'));
        if (!parentDir || parentDir === dir) break;
        dir = parentDir;
        const candidate = resolveRelativePath(cleanHref, dir);
        if (!candidates.includes(candidate)) candidates.push(candidate);
      }
    }

    // Also try with subdirectories mentioned in the href (e.g., "lessons/lessons-1977.md")
    if (href.includes('/')) {
      let dir = fileDir;
      for (let i = 0; i < 3; i++) {
        const parentDir = dir.substring(0, dir.lastIndexOf('/'));
        if (!parentDir || parentDir === dir) break;
        dir = parentDir;
        const candidate = resolveRelativePath(href, dir);
        if (!candidates.includes(candidate)) candidates.push(candidate);
      }
    }

    // Try candidates: check file existence via lightweight endpoint
    const token = localStorage.getItem('token') || '';
    for (const path of candidates) {
      try {
        const res = await fetch(`/api/files/exists?path=${encodeURIComponent(path)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (data.exists) {
          const fs = useFileStore.getState();
          // Pin current tab so it won't be replaced when navigating via link
          if (fs.activeFilePane === 'extra' && fs.splitTabId) fs.pinTab(fs.splitTabId);
          else if (fs.activeTabId) fs.pinTab(fs.activeTabId);
          // Push current file to history first (use live state, not closure)
          const currentFile = fs.openFile;
          if (currentFile) fs.navPush(currentFile.path);
          // Push destination
          fs.navPush(path);
          // Navigate
          const existingTab = fs.tabs.find(t => t.path === path);
          if (existingTab) {
            if (fs.activeFilePane === 'extra' && fs.splitTabId) {
              fs.openSplitTab(existingTab.id, fs.splitOrientation);
            } else {
              fs.setActiveTab(existingTab.id);
            }
          } else {
            onFileNavigate(path);
          }
          return;
        }
      } catch {
        // continue to next candidate
      }
    }

    // Fallback: try the primary path anyway (will show error from backend)
    onFileNavigate(primaryPath);
  }, [onFileNavigate, resolveRelativePath]);

  // Markdown custom components — must be before early return to keep hooks order stable
  const mdComponents = useMemo(() => {
    if (!openFile) return {};
    const fileDir = openFile.path.substring(0, openFile.path.lastIndexOf('/'));
    const token = localStorage.getItem('token') || '';
    return {
      img({ src, alt, node, ...rest }: any) {
        if (!src) return null;
        if (/^https?:\/\//.test(src)) {
          return <img src={src} alt={alt} style={{ maxWidth: '100%' }} />;
        }
        const resolvedPath = resolveRelativePath(src, fileDir);
        const apiUrl = towerHttpUrl(`/api/files/serve?path=${encodeURIComponent(resolvedPath)}&token=${encodeURIComponent(token)}`);
        return <img src={apiUrl} alt={alt} style={{ maxWidth: '100%' }} />;
      },
      code({ children, className, node, ...rest }: any) {
        // Block code (with language class) → render normally
        if (className) return <code className={className}>{children}</code>;

        // Inline code: detect file-like patterns and make them clickable
        const text = typeof children === 'string' ? children : String(children ?? '');
        const FILE_EXT_RE = /\.(md|txt|py|sh|js|ts|tsx|jsx|json|yaml|yml|html|css|csv|sql|toml|cfg|conf|xml|ini|env|log)$/i;
        const DIR_RE = /^[a-zA-Z0-9_\-./]+\/$/;  // ends with /
        if (FILE_EXT_RE.test(text) || DIR_RE.test(text)) {
          return (
            <code
              className="text-primary-400 hover:text-primary-300 cursor-pointer underline decoration-dotted underline-offset-2 bg-surface-800 px-1 py-0.5 rounded text-[0.85em]"
              title={t('openFileLink', { file: text })}
              onClick={(e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('[FileLink] clicked:', text, 'fileDir:', fileDir);
                navigateToFile(text, fileDir).catch(err => console.error('[FileLink] nav error:', err));
              }}
            >
              {children}
            </code>
          );
        }
        return <code className="bg-surface-800 px-1 py-0.5 rounded text-[0.85em]">{children}</code>;
      },
      a({ href, children, node, ...rest }: any) {
        if (!href) return <a>{children}</a>;

        // External links → new window
        if (/^https?:\/\//.test(href)) {
          return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
        }

        // Anchor links → scroll within the markdown container
        if (href.startsWith('#')) {
          return (
            <a
              href={href}
              onClick={(e: React.MouseEvent) => {
                e.preventDefault();
                const id = href.slice(1);
                const container = (e.target as HTMLElement).closest('.overflow-y-auto');
                const target = container?.querySelector(`[id="${CSS.escape(id)}"]`);
                if (target) {
                  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
              }}
            >
              {children}
            </a>
          );
        }

        // Relative path → navigate to file in tab
        const [filePart] = href.split('#');

        return (
          <a
            href="#"
            onClick={(e: React.MouseEvent) => {
              e.preventDefault();
              navigateToFile(filePart, fileDir).catch(err => console.error('[FileLink] nav error:', err));
            }}
            className="text-primary-400 hover:text-primary-300 underline cursor-pointer"
            title={filePart}
          >
            {children}
          </a>
        );
      },
    };
  }, [openFile?.path, onFileNavigate, resolveRelativePath, navigateToFile, t]);

  if (isMobilePersonalDocumentsView) {
    return <MobilePersonalDocumentsView />;
  }

  if (isPersonalMaterialsView) {
    return <PersonalMaterialsView />;
  }

  if (isPersonalTodoView) {
    return <PersonalTodoView />;
  }

  if (isPersonalArchiveView) {
    return <PersonalArchiveView />;
  }

  if (!openFile) {
    return (
      <div className="h-full flex flex-col bg-surface-950">
        {onMobileClose && (
          <div className="flex items-center justify-between px-4 h-12 border-b border-surface-800 shrink-0">
            <span className="text-base font-medium text-gray-400">{t('noFileSelected')}</span>
            <button onClick={onMobileClose} className="p-1.5 text-gray-400 hover:text-gray-200">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          </div>
        )}
        <div className="flex-1 flex items-center justify-center text-gray-400 text-base">
          {t('selectFileToView')}
        </div>
      </div>
    );
  }

  const PREVIEW_ONLY = new Set(['image', 'pdf', 'video', 'docx', 'xlsx', 'pptx', 'hwp', 'sqlite', 'cad', 'agent-draft']);
  const PREVIEWABLE = new Set(['image', 'pdf', 'video', 'html', 'markdown', 'agent-draft', 'docx', 'xlsx', 'pptx', 'hwp', 'sqlite', 'cad', ...TEXT_PREVIEW_FORMATS]);
  const hasPreview = PREVIEWABLE.has(openFile.language) || CODE_PREVIEW_FORMATS.has(openFile.language);
  const isPreviewOnly = PREVIEW_ONLY.has(openFile.language);
  const hasDirectEdit = previewDirectEditEnabled && openFile.language === 'markdown';
  const isMobileDocument = Boolean(onMobileClose && openFile.language === 'markdown');
  const isWriteMode = contextPanelTab === 'write' || (openFile.language === 'markdown' && (contextPanelTab === 'raw' || contextPanelTab === 'editor'));
  const isSourceMode = contextPanelTab === 'source' || (openFile.language !== 'markdown' && (contextPanelTab === 'raw' || contextPanelTab === 'editor'));
  const rawName = openFile.path.split('/').pop() || '';
  // Fix double-encoded Korean filenames (latin1→utf8 + NFD→NFC)
  let fileName = rawName;
  try {
    if (/[\u00c0-\u00ff][\u0080-\u00bf]/.test(rawName)) {
      const bytes = new Uint8Array([...rawName].map(c => c.charCodeAt(0)));
      fileName = new TextDecoder('utf-8').decode(bytes).normalize('NFC');
    } else {
      fileName = rawName.normalize('NFC');
    }
  } catch {
    fileName = rawName.normalize('NFC');
  }

  return (
    <div className="h-full flex flex-col bg-surface-950">
      <FileOperationFeedback scope={saveScope(openFile.path)} />
      {/* Tab bar — always shown when tabs exist */}
      {tabs.length > 0 && !hideTabBar && <TabBar />}
      {showShareModal && !isPersonalFile && <ShareModal filePath={openFile.path} onClose={() => setShowShareModal(false)} />}
      {urlPreviewDialogOpen && (
        <OpenUrlPreviewDialog
          onClose={() => setUrlPreviewDialogOpen(false)}
          onOpen={(url) => {
            if (!screenPreviewStorageKey || !openFile) return;
            localStorage.setItem(screenPreviewStorageKey, url);
            setScreenPreviewPath(openFile.path);
            setUrlPreviewDialogOpen(false);
          }}
        />
      )}
      {compareOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={() => setCompareOpen(false)}>
          <div className="flex max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-surface-700 bg-surface-950 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 border-b border-surface-800 px-5 py-4">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300">{t('fileChanged')}</div>
                <h2 className="mt-1 text-lg font-bold text-gray-100">{t('compareCurrentAndLatest')}</h2>
                <p className="mt-1 text-sm text-surface-500">{t('compareCurrentAndLatestDescription')}</p>
              </div>
              <button onClick={() => setCompareOpen(false)} className="rounded-lg border border-surface-700 bg-surface-900 px-3 py-1.5 text-sm font-semibold text-surface-300 hover:text-gray-100">{t('common:close')}</button>
            </div>
            <div className="min-h-0 flex-1">
              {compareLoading ? (
                <div className="py-16 text-center text-sm text-surface-500">{t('loadingLatestFile')}</div>
              ) : compareError ? (
                <div className="m-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">{compareError}</div>
              ) : (
                <div className="h-full min-h-[420px] overflow-auto p-4 font-mono text-[12px] leading-5">
                  {compareDiff.length === 0 ? (
                    <div className="py-12 text-center text-sm text-surface-500">{t('noChangesToCompare')}</div>
                  ) : (
                    (() => {
                      let hunkCursor = 0;
                      let inChange = false;
                      return compareDiff.map((line, index) => {
                        const isChange = line.kind !== 'same';
                        const startsHunk = isChange && !inChange;
                        if (startsHunk) inChange = true;
                        if (!isChange) inChange = false;
                        const hunk = startsHunk ? compareHunks[hunkCursor++] : null;
                        return (
                          <div key={index}>
                            {hunk && (
                              <div className="my-2 flex items-center justify-between gap-3 rounded-lg border border-surface-700 bg-surface-900/80 px-3 py-2 font-sans text-[12px] text-surface-400">
                                <span>{t('changeGroup', { number: hunk.id + 1 })}</span>
                                <button onClick={() => acceptDiffHunk(hunk)} className="rounded-md bg-primary-600 px-2 py-1 font-semibold text-white hover:bg-primary-500">{t('applyThisChange')}</button>
                              </div>
                            )}
                            <div
                              className={line.kind === 'add'
                                ? 'bg-emerald-500/10 text-emerald-100'
                                : line.kind === 'remove'
                                  ? 'bg-red-500/10 text-red-100'
                                  : 'text-surface-400'}
                            >
                              <span className="mr-2 inline-block w-4 select-none text-surface-600">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span>
                              <span className="whitespace-pre-wrap break-words">{line.text || ' '}</span>
                            </div>
                          </div>
                        );
                      });
                    })()
                  )}
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-surface-800 px-5 py-3">
              <p className="text-[12px] text-surface-500">{t('diffColorExplanation')}</p>
              <div className="flex items-center gap-2">
                <button onClick={() => setCompareOpen(false)} className="rounded-lg border border-surface-700 bg-surface-900 px-3 py-1.5 text-sm font-semibold text-surface-300 hover:text-gray-100">{t('keepMyEdits')}</button>
                <button onClick={acceptLatestDiskContent} disabled={latestDiskContent == null} className="rounded-lg bg-primary-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-50">{t('replaceWithLatestFile')}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {openFile && <KeepDashboard key={openFile.path} filePath={openFile.path} modified={openFile.modified} />}
      {/* File header */}
      <div className={`relative z-20 flex shrink-0 flex-wrap items-center gap-2 overflow-visible whitespace-nowrap px-3 pt-[max(0.5rem,env(safe-area-inset-top,0px))] sm:flex-nowrap sm:overflow-x-auto sm:pt-0 ${isPersonalFile ? 'pb-2.5 min-h-[58px] sm:py-2.5' : 'pb-2 min-h-[48px] sm:py-2 sm:min-h-[38px]'} border-b border-surface-700 bg-surface-950 text-base leading-tight scrollbar-none`}>
        {onMobileClose && (
          <button
            onClick={onMobileClose}
            className="flex h-8 items-center gap-1 rounded-md px-1.5 text-gray-400 hover:bg-surface-800 hover:text-gray-200 shrink-0"
            title={t('closeFileAndGoBack')}
            aria-label={t('closeFile')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            <span className="hidden text-sm font-medium min-[420px]:inline">{t('back')}</span>
          </button>
        )}

        {/* Back / Forward navigation */}
        {navHistory.length > 1 && (
          <div className="hidden items-center gap-0.5 shrink-0 sm:flex">
            <button
              onClick={handleNavBack}
              disabled={navIndex <= 0}
              className={`p-0.5 rounded transition-colors ${navIndex <= 0 ? 'text-gray-600 cursor-not-allowed' : 'text-gray-400 hover:text-gray-200 hover:bg-surface-700'}`}
              title={t('backShortcut')}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <button
              onClick={handleNavForward}
              disabled={navIndex >= navHistory.length - 1}
              className={`p-0.5 rounded transition-colors ${navIndex >= navHistory.length - 1 ? 'text-gray-600 cursor-not-allowed' : 'text-gray-400 hover:text-gray-200 hover:bg-surface-700'}`}
              title={t('forwardShortcut')}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        )}

        {isPersonalFile ? (
          <label className="group/title min-w-[7rem] flex-1">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-surface-500 group-focus-within/title:text-primary-300">{t('noteTitle')}</span>
            <span className="flex h-9 items-center rounded-lg border border-surface-700 bg-surface-900/80 shadow-sm transition group-hover/title:border-surface-600 group-focus-within/title:border-primary-500 group-focus-within/title:ring-2 group-focus-within/title:ring-primary-500/15">
              <input
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={() => { void commitPersonalTitle(); }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
                  if (event.key === 'Escape') { setTitleDraft(personalFileTitle); event.currentTarget.blur(); }
                }}
                disabled={renamingTitle}
                placeholder={t('enterNoteTitle')}
                className="h-full min-w-0 flex-1 bg-transparent px-3 text-sm font-semibold text-surface-100 outline-none placeholder:font-normal placeholder:text-surface-500 disabled:opacity-60"
                aria-label={t('personalNoteTitleAndFilename')}
                title={t('noteTitleRenamesFile')}
              />
              <span className="shrink-0 border-l border-surface-700 px-2 text-[11px] font-medium text-surface-500" aria-hidden="true">.md</span>
            </span>
          </label>
        ) : (
          <span className="min-w-0 flex-1 truncate text-gray-400" title={openFile.path}>
            {fileName}
          </span>
        )}
        {openFile.modified && (
          <span className="shrink-0 text-sm text-primary-300">{t('modified', { defaultValue: '수정됨' })}</span>
        )}

        {isScreenPreviewCode && (
          <div className="flex shrink-0 rounded-md bg-surface-800 p-0.5">
            <button
              type="button"
              onClick={() => setScreenPreviewPath(null)}
              className={`rounded px-2 py-0.5 text-sm ${!screenPreviewActive ? 'bg-surface-700 text-white' : 'text-gray-400 hover:text-gray-200'}`}
            >
              {t('codeMode')}
            </button>
            <button
              type="button"
              onClick={() => screenPreviewUrl ? setScreenPreviewPath(openFile.path) : setUrlPreviewDialogOpen(true)}
              className={`rounded px-2 py-0.5 text-sm ${screenPreviewActive ? 'bg-surface-700 text-white' : 'text-gray-400 hover:text-gray-200'}`}
            >
              {t('screenPreviewMode')}
            </button>
          </div>
        )}

        {hasPreview && !isPreviewOnly && !isScreenPreviewCode && !isMobileDocument && (
          <>
            <div className="hidden shrink-0 rounded-md bg-surface-800 p-0.5 sm:flex">
              <button
                className={`shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-sm ${contextPanelTab === 'preview' ? 'bg-surface-700 text-white' : 'text-gray-400'}`}
                onClick={() => setContextPanelTab('preview')}
                title={t('readDocument')}
              >
                {t('readMode')}
              </button>
              {openFile.language === 'markdown' ? (
                <>
                  <button
                    className={`shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-sm ${isWriteMode ? 'bg-surface-700 text-white' : 'text-gray-400'}`}
                    onClick={() => setContextPanelTab('write')}
                    title={t('editMarkdownDocument')}
                  >
                    {t('editMode')}
                  </button>
                  <button
                    className={`shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-sm ${contextPanelTab === 'split' ? 'bg-surface-700 text-white' : 'text-gray-400'}`}
                    onClick={() => setContextPanelTab('split')}
                    title={t('editWithPreview')}
                  >
                    {t('splitMode')}
                  </button>

                </>
              ) : (
                <button
                  className={`shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-sm ${isSourceMode ? 'bg-surface-700 text-white' : 'text-gray-400'}`}
                  onClick={() => setContextPanelTab('source')}
                  title={t('editSource')}
                >
                  {t('sourceMode')}
                </button>
              )}
            </div>
            {isMobileDocument ? (
              <button
                type="button"
                onClick={() => setContextPanelTab(isWriteMode ? 'preview' : 'write')}
                className={`flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition-colors ${isWriteMode ? 'border-primary-500/40 bg-primary-500/15 text-primary-200' : 'border-surface-700 bg-surface-900 text-surface-200 hover:bg-surface-800'}`}
                title={isWriteMode ? t('readDocument') : t('editMarkdownDocument')}
                aria-label={isWriteMode ? t('readDocument') : t('editMarkdownDocument')}
              >
                {isWriteMode ? (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M2.75 12s3.5-6 9.25-6 9.25 6 9.25 6-3.5 6-9.25 6S2.75 12 2.75 12Z" /><circle cx="12" cy="12" r="2.25" /></svg>
                ) : (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="m15.5 5.5 3 3M4.75 19.25l3.75-.75L18 9a2.12 2.12 0 0 0-3-3l-9.5 9.5-.75 3.75Z" /></svg>
                )}
                <span>{isWriteMode ? t('readMode') : t('editMode')}</span>
              </button>
            ) : (
              <select
                value={contextPanelTab === 'edit' && hasDirectEdit ? 'edit' : contextPanelTab === 'split' ? 'split' : isWriteMode ? 'write' : isSourceMode ? 'source' : 'preview'}
                onChange={(e) => setContextPanelTab(e.target.value as 'preview' | 'write' | 'split' | 'source' | 'edit')}
                className="h-8 w-[4.75rem] shrink-0 rounded-md border border-surface-700 bg-surface-800 px-1.5 text-xs text-gray-200 outline-none sm:hidden"
                title={t('viewMode')}
                aria-label={t('viewMode')}
              >
                <option value="preview">{t('readMode')}</option>
                {openFile.language === 'markdown' && <option value="write">{t('editMode')}</option>}
                {openFile.language === 'markdown' && <option value="split">{t('splitMode')}</option>}
                <option value="source">{t('sourceMode')}</option>
                {hasDirectEdit && <option value="edit">{t('quickEditBeta')}</option>}
              </select>
            )}
          </>
        )}

        {openFile.language === 'markdown' && (
          <FileActionsMenu>
              <MarkdownTtsControls content={openFile.content} className="w-full justify-start" />
              {!isPersonalFile && (
                <button
                  onClick={() => setShowShareModal(true)}
                  className="rounded-md border border-primary-500/30 bg-primary-600/15 px-3 py-1.5 text-left text-sm font-medium text-primary-300 transition-colors hover:bg-primary-600/25 hover:text-primary-200"
                  title={t('createExternalShareLink')}
                >
                  {t('shareLink')}
                </button>
              )}
              <button className="rounded px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-surface-800" onClick={() => setContextPanelTab('source')}>{t('viewSource')}</button>
              {hasDirectEdit && <button className="rounded px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-surface-800" onClick={() => setContextPanelTab('edit')}>{t('quickEditBeta')}</button>}
              <button
                onClick={handleReload}
                className="inline-flex items-center gap-1 rounded-md border border-surface-600 bg-surface-800 px-3 py-1.5 text-sm font-medium whitespace-nowrap text-gray-300 transition-colors hover:bg-surface-700 hover:text-white"
                title={t('reloadFile')}
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {t('refresh')}
              </button>
          </FileActionsMenu>
        )}

        {isMobileDocument && (
          <button
            type="button"
            onClick={() => setContextPanelTab(isWriteMode ? 'preview' : 'write')}
            className={`flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition-colors ${isWriteMode ? 'border-primary-500/40 bg-primary-500/15 text-primary-200' : 'border-surface-700 bg-surface-900 text-surface-200 hover:bg-surface-800'}`}
            title={isWriteMode ? t('readDocument') : t('editMarkdownDocument')}
            aria-label={isWriteMode ? t('readDocument') : t('editMarkdownDocument')}
          >
            {isWriteMode ? (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M2.75 12s3.5-6 9.25-6 9.25 6 9.25 6-3.5 6-9.25 6S2.75 12 2.75 12Z" /><circle cx="12" cy="12" r="2.25" /></svg>
            ) : (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="m15.5 5.5 3 3M4.75 19.25l3.75-.75L18 9a2.12 2.12 0 0 0-3-3l-9.5 9.5-.75 3.75Z" /></svg>
            )}
            <span>{isWriteMode ? t('readMode') : t('editMode')}</span>
          </button>
        )}

        {openFile.modified && onSave && (
          <button
            onClick={() => handleSave()}
            className="shrink-0 whitespace-nowrap rounded-md border border-primary-500/30 bg-primary-600 px-2.5 py-1 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-500 focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary-300"
          >
            Save
          </button>
        )}

        {!onMobileClose && !fullScreen && (
          <button
            onClick={() => setContextPanelExpanded(!contextPanelExpanded)}
            className="p-0.5 hover:text-primary-400 transition-colors text-gray-400"
            title={contextPanelExpanded ? 'Side panel' : 'Expand'}
          >
            {contextPanelExpanded ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
              </svg>
            )}
          </button>
        )}

        <button
          onClick={handleClose}
          className={`p-1 rounded-md transition-colors text-gray-400 ${
            fullScreen || tabId
              ? 'hover:text-red-400 hover:bg-red-400/10'
              : 'hover:text-gray-200 hover:bg-surface-700'
          }`}
          title={tabId ? 'Close split pane' : fullScreen ? 'Close tab' : 'Collapse panel'}
        >
          {fullScreen || tabId ? (
            /* × for files view / split pane */
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            /* › arrow for side panel — collapse/fold */
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          )}
        </button>
      </div>

      {/* Conflict banner */}
      {externalChange && (
        <div className="tone-card tone-warning flex items-center gap-2 px-3 py-2 border-b text-base">
          <svg className="tone-warning tone-text w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <span className="tone-warning tone-text text-sm flex-1">{t('externalFileChangeDetected')}</span>
          <button
            onClick={handleCompareLatest}
            className="tone-action tone-warning text-sm px-2 py-0.5 rounded transition-colors"
          >
            {t('compareChanges')}
          </button>
          <button
            onClick={handleReload}
            className="tone-action tone-warning text-sm px-2 py-0.5 rounded transition-colors"
          >
            {t('applyLatestVersion')}
          </button>
          <button
            onClick={keepLocalEdits}
            className="text-sm px-2 py-0.5 bg-surface-700 hover:bg-surface-600 rounded transition-colors text-gray-300"
          >
            {t('keepMyEdits')}
          </button>
        </div>
      )}

      {/* Content */}
      {screenPreviewActive && screenPreviewUrl ? (
        <div className="flex-1 min-h-0 relative bg-surface-950">
          <UrlPreviewSurface
            url={screenPreviewUrl}
            className="absolute inset-0"
            onChangeUrl={() => setUrlPreviewDialogOpen(true)}
          />
        </div>
      ) : isPreviewOnly || (hasPreview && contextPanelTab === 'preview') ? (
        <div className="flex-1 min-h-0 relative bg-surface-950">
          <PdfPreviewCache activeFile={openFile.language === 'pdf' ? { path: openFile.path, revision: getPreviewRevision(openFile.content, openFile.encoding) } : null} />
          <OfficePreviewCache activeFile={OFFICE_FORMATS.has(openFile.language) ? { path: openFile.path, language: openFile.language as OfficePreviewLanguage, revision: getPreviewRevision(openFile.content, openFile.encoding) } : null} />
          {markdownPreviewPaths.map((path) => {
            const isActive = path === activeMarkdownPath;
            const tab = markdownTabsByPath.get(path);
            const content = isActive ? openFile.content : tab?.content ?? '';
            const revision = `${path}:${content.length}:${content.slice(0, 64)}`;
            return (
              <div
                key={path}
                ref={isActive ? mdScrollRef : undefined}
                className={isActive ? 'absolute inset-0 overflow-y-auto overflow-x-hidden bg-surface-950' : 'hidden'}
                id={isActive ? 'md-scroll-container' : undefined}
              >
                <div className={`mx-auto w-full max-w-[920px] ${isMobileDocument ? 'px-4 pb-[calc(2rem+env(safe-area-inset-bottom,0px))] pt-5' : 'px-5 py-6'} sm:px-7 sm:py-6 lg:px-10`}>
                  <div ref={isActive ? mdSelectableRef : undefined} data-file-selectable-body={isActive ? 'true' : undefined} className="select-text">
                    <MarkdownReadSurface
                      key={revision}
                      content={content}
                      components={mdComponents}
                      className={`prose prose-invert max-w-none markdown-document ${isMobileDocument ? 'mobile-markdown-document' : 'prose-sm'}`}
                    />
                  </div>
                </div>
              </div>
            );
          })}
          {isPricingAppFile(openFile.path) ? (
            <PricingFilePreview content={openFile.content} />
          ) : openFile.language === 'agent-draft' ? (
            <AgentDraftPreview content={openFile.content} />
          ) : openFile.language === 'image' ? (
            <ImagePreview filePath={openFile.path} />
          ) : openFile.language === 'video' ? (
            <VideoPreview filePath={openFile.path} />
          ) : openFile.language === 'pdf' ? null : openFile.language === 'html' ? (
            // Wrap so useScrollMemory can querySelector('iframe') and hook into
            // its contentDocument.scrollingElement once loaded (sandbox is
            // allow-same-origin so this is permitted).
            <div ref={htmlWrapRef} className="absolute inset-0">
              <HtmlPreviewSurface key={contentRevision} content={openFile.content} filePath={openFile.path} className="absolute inset-0" />
            </div>
          ) : CODE_PREVIEW_FORMATS.has(openFile.language) ? (
            <div className="absolute inset-0 overflow-hidden bg-surface-950">
              <CodeEditor value={openFile.content} language={openFile.language} readOnly formatForDisplay />
            </div>
          ) : TEXT_PREVIEW_FORMATS.has(openFile.language) ? (
            <div className="absolute inset-0 overflow-auto bg-surface-950 p-4">
              <pre ref={textSelectableRef} data-file-selectable-body="true" className="m-0 whitespace-pre-wrap break-words text-[15px] leading-6 text-surface-100 font-mono select-text">
                {openFile.content}
              </pre>
            </div>
          ) : openFile.language === 'markdown' ? null : OFFICE_FORMATS.has(openFile.language) ? null : openFile.language === 'sqlite' ? (
            <div className="absolute inset-0 flex flex-col">
              <React.Suspense fallback={
                <div className="flex items-center justify-center h-full text-gray-400 text-base">
                  <svg className="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  {t('loadingSqliteViewer')}
                </div>
              }>
                <SqlitePreview filePath={openFile.path} />
              </React.Suspense>
            </div>
          ) : openFile.language === 'cad' ? (
            <div className="absolute inset-0 flex flex-col">
              <React.Suspense fallback={
                <div className="flex items-center justify-center h-full text-gray-400 text-base">
                  <svg className="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  {t('loadingCadViewer')}
                </div>
              }>
                <CadPreview filePath={openFile.path} />
              </React.Suspense>
            </div>
          ) : null}
        </div>
      ) : openFile.language === 'markdown' && contextPanelTab === 'split' ? (
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 bg-surface-950">
          <div ref={codeWrapRef} className="min-h-0 overflow-y-auto border-r border-surface-800">
            <MarkdownEditor
              value={openFile.content}
              filePath={openFile.path}
              onChange={updateContent}
              onSave={handleSave}
            />
          </div>
          <div ref={mdScrollRef} className="min-h-0 overflow-y-auto px-5 py-6 sm:px-7 lg:px-10">
            <MarkdownReadSurface
              content={openFile.content}
              components={mdComponents}
              className="prose prose-invert prose-sm max-w-none markdown-document"
            />
          </div>
        </div>
      ) : hasDirectEdit && contextPanelTab === 'edit' ? (
        openFile.language === 'html' ? (
          <div ref={htmlWrapRef} className="flex-1 min-h-0 relative bg-surface-950">
            <HtmlDirectEditSurface
              content={openFile.content}
              onContentChange={handlePreviewDirectEditChange}
              onSave={handleSave}
              className="absolute inset-0"
            />
          </div>
        ) : (
          <div ref={mdScrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden bg-surface-950" id="md-scroll-container">
            <div className="mx-auto w-full max-w-[920px] px-5 py-6 sm:px-7 lg:px-10">
              <MarkdownPreviewSurface
                content={openFile.content}
                filePath={openFile.path}
                components={mdComponents}
                onContentChange={handlePreviewDirectEditChange}
                inlineEditEnabled={false}
                previewDirectEditEnabled={true}
                inlineEditDisabled={false}
                className="prose prose-invert prose-sm max-w-none markdown-document"
              />
            </div>
          </div>
        )
      ) : (
        <div ref={codeWrapRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          {openFile.language === 'markdown' && !isSourceMode ? (
            <MarkdownEditor
              value={openFile.content}
              filePath={openFile.path}
              onChange={updateContent}
              onSave={handleSave}
            />
          ) : (
            <CodeEditor
              value={openFile.content}
              language={openFile.language}
              onChange={updateContent}
              onSave={handleSave}
            />
          )}
        </div>
      )}
    </div>
  );
}
