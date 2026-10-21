import { towerHttpUrl } from '../../features/client-connection/connection';
import { PricingFilePreview, isPricingAppFile } from '../interactive-apps/PricingFilePreview';
import { FileOperationFeedback } from '../../features/file-operation-feedback/FileOperationFeedback';
import { saveFileOperation } from '../../features/file-operation-feedback/save-operation';
import { saveScope } from '../../features/file-operation-feedback/feedback';
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { toastSuccess, toastError } from '../../utils/toast';
import { MarkdownReadSurface } from './MarkdownReadSurface';
import { FileActionsMenu } from './FileActionsMenu';
import { ShareModal } from './ShareModal';
import { HtmlPreviewSurface } from './HtmlPreviewSurface';
import { shouldUseFileBodySelectAll, selectElementTextContents } from './fileSelection';
import { useSettingsStore } from '../../stores/settings-store';
import { buildPdfServeUrl } from '../../utils/pdf-open';
import { useTranslation } from 'react-i18next';

// ─── Helpers ───
function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

function detectLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', json: 'json', ipynb: 'json', md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', css: 'css',
    sh: 'shell', sql: 'sql', yaml: 'yaml', yml: 'yaml',
    txt: 'text', rst: 'text', org: 'text', csv: 'csv', tsv: 'csv',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image',
    pdf: 'pdf', mp4: 'video', m4v: 'video', mov: 'video', webm: 'video',
    docx: 'docx', doc: 'docx',
    xlsx: 'xlsx', xls: 'xlsx',
    pptx: 'pptx', ppt: 'pptx',
    hwp: 'hwp', hwpx: 'hwp',
    db: 'sqlite', sqlite: 'sqlite', sqlite3: 'sqlite',
    dxf: 'cad', dwg: 'cad',
  };
  return map[ext] || 'plaintext';
}

// Lazy-loaded Office preview components
const DocxPreview = React.lazy(() => import('./DocxPreview').then(m => ({ default: m.DocxPreview })));
const XlsxPreview = React.lazy(() => import('./XlsxPreview').then(m => ({ default: m.XlsxPreview })));
const PptxPreview = React.lazy(() => import('./PptxPreview').then(m => ({ default: m.PptxPreview })));
const HwpPreview = React.lazy(() => import('./HwpPreview').then(m => ({ default: m.HwpPreview })));
const SqlitePreview = React.lazy(() => import('./SqlitePreview').then(m => ({ default: m.SqlitePreview })));
const CadPreview = React.lazy(() => import('./CadPreview').then(m => ({ default: m.CadPreview })));
const LazyCodeEditor = React.lazy(() => import('../editor/CodeEditor').then(m => ({ default: m.CodeEditor })));
const LazyMarkdownEditor = React.lazy(() => import('./markdown-editor/MarkdownEditor').then(m => ({ default: m.MarkdownEditor })));
const LazyMarkdownTtsControls = React.lazy(() => import('./MarkdownTtsControls').then(m => ({ default: m.MarkdownTtsControls })));
const LazyMarkdownPreviewSurface = React.lazy(() => import('./MarkdownPreviewSurface').then(m => ({ default: m.MarkdownPreviewSurface })));
const LazyHtmlDirectEditSurface = React.lazy(() => import('./HtmlDirectEditSurface').then(m => ({ default: m.HtmlDirectEditSurface })));

function FeatureLoading({ label = '기능을 불러오는 중…' }: { label?: string }) {
  return <div className="flex h-full min-h-24 items-center justify-center text-sm text-surface-500">{label}</div>;
}

function CodeEditor(props: React.ComponentProps<typeof LazyCodeEditor>) {
  const { t } = useTranslation('files');
  return <React.Suspense fallback={<FeatureLoading label={t('loadingEditor')} />}><LazyCodeEditor {...props} /></React.Suspense>;
}
function MarkdownEditor(props: React.ComponentProps<typeof LazyMarkdownEditor>) {
  const { t } = useTranslation('files');
  return <React.Suspense fallback={<FeatureLoading label={t('loadingMarkdownEditor')} />}><LazyMarkdownEditor {...props} /></React.Suspense>;
}
function MarkdownTtsControls(props: React.ComponentProps<typeof LazyMarkdownTtsControls>) {
  return <React.Suspense fallback={<span className={props.className} aria-hidden="true" />}><LazyMarkdownTtsControls {...props} /></React.Suspense>;
}
function MarkdownPreviewSurface(props: React.ComponentProps<typeof LazyMarkdownPreviewSurface>) {
  const { t } = useTranslation('files');
  return <React.Suspense fallback={<FeatureLoading label={t('loadingQuickEdit')} />}><LazyMarkdownPreviewSurface {...props} /></React.Suspense>;
}
function HtmlDirectEditSurface(props: React.ComponentProps<typeof LazyHtmlDirectEditSurface>) {
  const { t } = useTranslation('files');
  return <React.Suspense fallback={<FeatureLoading label={t('loadingHtmlEditor')} />}><LazyHtmlDirectEditSurface {...props} /></React.Suspense>;
}

const OFFICE_FORMATS = new Set(['docx', 'xlsx', 'pptx', 'hwp']);
const TEXT_PREVIEW_FORMATS = new Set(['text', 'csv']);
const CODE_PREVIEW_FORMATS = new Set(['json', 'yaml', 'javascript', 'typescript', 'jsx', 'tsx', 'python', 'css']);

const DOCUMENT_WIDTHS = {
  readable: 'max-w-[920px]',
  wide: 'max-w-[1240px]',
  full: 'max-w-none',
} as const;

type DocumentWidthMode = keyof typeof DOCUMENT_WIDTHS;
type FileViewerMode = 'preview' | 'write' | 'split' | 'source' | 'edit' | 'raw';

function decodeName(raw: string): string {
  try {
    if (/[\u00c0-\u00ff][\u0080-\u00bf]/.test(raw)) {
      const bytes = new Uint8Array([...raw].map(c => c.charCodeAt(0)));
      return new TextDecoder('utf-8').decode(bytes).normalize('NFC');
    }
    return raw.normalize('NFC');
  } catch {
    return raw.normalize('NFC');
  }
}

// ─── Preview components ───
function ImagePreview({ filePath }: { filePath: string }) {
  const token = localStorage.getItem('token') || '';
  const src = filePath.startsWith('/api/session-attachments/')
    ? filePath
    : towerHttpUrl(`/api/files/serve?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(token)}`);
  return (
    <div className="flex-1 flex items-center justify-center bg-surface-900 p-4 overflow-auto">
      <img src={src} alt={filePath.split('/').pop()} className="max-w-full max-h-full object-contain" />
    </div>
  );
}

function PdfPreview({ filePath }: { filePath: string }) {
  const src = buildPdfServeUrl(filePath);
  return (
    <div className="flex-1 min-h-0 bg-surface-950">
      <iframe
        src={src}
        title={decodeName(filePath.split('/').pop() || 'document.pdf')}
        className="h-full w-full border-0 bg-white"
      />
    </div>
  );
}

function VideoPreview({ filePath }: { filePath: string }) {
  const { t } = useTranslation('files');
  const token = localStorage.getItem('token') || '';
  const src = towerHttpUrl(`/api/files/serve?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(token)}`);
  const fileName = filePath.split('/').pop() || 'video';
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-black p-4">
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

function TextPreview({ content, language, selectableRef }: { content: string; language: string; selectableRef?: React.Ref<HTMLPreElement> }) {
  if (language === 'json') {
    try {
      content = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // Keep original content when JSON is incomplete or invalid.
    }
  }
  return (
    <div className="flex-1 min-h-0 overflow-auto bg-surface-950 p-5">
      <pre ref={selectableRef} data-file-selectable-body="true" className="m-0 whitespace-pre-wrap break-words text-[15px] leading-6 text-gray-200 font-mono select-text">
        {content}
      </pre>
    </div>
  );
}

// ─── Main ───
export function FileViewerPage() {
  const { t } = useTranslation('files');
  const params = new URLSearchParams(window.location.search);
  const filePath = params.get('path') || '';
  const language = detectLanguage(filePath);
  const PREVIEWABLE = new Set(['markdown', 'html', 'image', 'pdf', 'video', 'docx', 'xlsx', 'pptx', 'hwp', 'sqlite', 'cad', ...TEXT_PREVIEW_FORMATS, ...CODE_PREVIEW_FORMATS]);
  const BINARY = new Set(['image', 'pdf', 'video', 'docx', 'xlsx', 'pptx', 'hwp', 'sqlite', 'cad']);
  const rawMode = params.get('mode');
  const explicitMode: FileViewerMode | null =
    rawMode === 'preview' || rawMode === 'edit' || rawMode === 'write' || rawMode === 'split' || rawMode === 'source' || rawMode === 'raw'
      ? rawMode === 'raw'
        ? 'source'
        : rawMode
      : rawMode === 'editor'
        ? 'source'
        : null;
  const defaultMode: FileViewerMode = PREVIEWABLE.has(language) ? 'preview' : 'source';

  const [mode, setMode] = useState<FileViewerMode>(explicitMode || defaultMode);
  const currentFilePath = useRef(filePath);
  currentFilePath.current = filePath;
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showShareModal, setShowShareModal] = useState(false);
  const [documentWidth, setDocumentWidth] = useState<DocumentWidthMode>('readable');
  const [documentZoom, setDocumentZoom] = useState(1);
  const textSelectableRef = useRef<HTMLPreElement>(null);
  const mdSelectableRef = useRef<HTMLDivElement>(null);
  const serverConfig = useSettingsStore((s) => s.serverConfig);
  const setServerConfig = useSettingsStore((s) => s.setServerConfig);
  const previewDirectEditEnabled = serverConfig?.previewDirectEditEnabled === true;

  const fileName = decodeName(filePath.split('/').pop() || '');
  const isBinary = BINARY.has(language);
  const hasPreview = PREVIEWABLE.has(language);
  const hasDirectEdit = previewDirectEditEnabled && language === 'markdown';
  const modified = content !== originalContent;
  const showDocumentControls = language === 'markdown' && (mode === 'preview' || mode === 'edit');
  const documentWidthClass = DOCUMENT_WIDTHS[documentWidth];
  const documentZoomPercent = Math.round(documentZoom * 100);

  const handlePreviewDirectEditChange = useCallback((next: string) => {
    setContent(next);
  }, []);

  useEffect(() => {
    if (isBinary) setMode('preview');
    else if (mode === 'edit' && !hasDirectEdit) setMode(hasPreview ? 'preview' : 'source');
  }, [isBinary, mode, hasDirectEdit, hasPreview]);

  // Standalone /file-viewer route doesn't mount App.tsx, so load the small
  // server config payload here too. Missing/failed config means feature off.
  useEffect(() => {
    if (serverConfig) return;
    fetch('/api/config', { headers: getAuthHeaders() })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setServerConfig(data); })
      .catch(() => {});
  }, [serverConfig, setServerConfig]);

  const loadFileContent = useCallback(async () => {
    if (!filePath) {
      setError(t('noFilePath'));
      setLoading(false);
      return;
    }
    if (isBinary) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');
    const headers = getAuthHeaders();
    delete headers['Content-Type'];
    try {
      const res = await fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`, { headers });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to load');
      const data = await res.json();
      setContent(data.content);
      setOriginalContent(data.content);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [filePath, isBinary, t]);

  // Fetch file content (skip for binary)
  useEffect(() => {
    void loadFileContent();
  }, [loadFileContent]);

  // Set page title
  useEffect(() => {
    document.title = fileName ? `${fileName} — Tower` : 'File Viewer — Tower';
  }, [fileName]);

  const handleRefresh = useCallback(() => {
    if (modified) {
      toastError(t('refreshBlockedByUnsavedChanges'));
      return;
    }
    void loadFileContent().then(() => toastSuccess(t('refreshComplete')));
  }, [loadFileContent, modified, t]);

  const handleSave = useCallback(async (nextContent = content) => {
    await saveFileOperation(filePath, () => fetch('/api/files/write', {
      method: 'POST', headers: getAuthHeaders(),
      body: JSON.stringify({ path: filePath, content: nextContent }),
    }), () => {
      if (currentFilePath.current === filePath) setOriginalContent(nextContent);
    });
  }, [filePath, content, t]);

  // Ctrl+S / ⌘S saves from both Raw and rendered Edit modes.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (modified) handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [modified, handleSave]);

  // In standalone file windows, Mod+A follows the same rule as the embedded
  // file tab: select rendered markdown/text body only, not the viewer header.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const selectableRoot = mode === 'preview'
        ? language === 'markdown'
          ? mdSelectableRef.current
          : TEXT_PREVIEW_FORMATS.has(language)
            ? textSelectableRef.current
            : null
        : null;

      if (!shouldUseFileBodySelectAll(e, selectableRoot)) return;
      e.preventDefault();
      selectElementTextContents(selectableRoot);
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [language, mode, filePath]);

  // Markdown image resolver
  const mdComponents = useMemo(() => {
    const fileDir = filePath.substring(0, filePath.lastIndexOf('/'));
    const token = localStorage.getItem('token') || '';
    return {
      img({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) {
        if (!src) return null;
        if (/^https?:\/\//.test(src)) return <img src={src} alt={alt} {...props} style={{ maxWidth: '100%' }} />;
        let resolvedPath = src.startsWith('/') ? src : fileDir + '/' + src;
        const parts = resolvedPath.split('/');
        const normalized: string[] = [];
        for (const p of parts) {
          if (p === '..') normalized.pop();
          else if (p !== '.') normalized.push(p);
        }
        resolvedPath = normalized.join('/');
        const apiUrl = towerHttpUrl(`/api/files/serve?path=${encodeURIComponent(resolvedPath)}&token=${encodeURIComponent(token)}`);
        return <img src={apiUrl} alt={alt} {...props} style={{ maxWidth: '100%' }} />;
      },
      code({ className, children, ...props }: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) {
        return <code className={className} {...props}>{children}</code>;
      },
    };
  }, [filePath]);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-surface-900 text-gray-400">
        {t('loading')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center bg-surface-900 text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-surface-900 text-gray-200">
      <FileOperationFeedback scope={saveScope(filePath)} />
      {showShareModal && <ShareModal filePath={filePath} onClose={() => setShowShareModal(false)} />}

      {/* Header */}
      <div className="relative z-20 flex min-h-11 shrink-0 flex-wrap items-center gap-2 overflow-visible border-b border-surface-700 bg-surface-900 px-3 py-1.5 sm:h-11 sm:flex-nowrap sm:px-4 sm:py-0">
        <span className="min-w-0 flex-1 truncate text-base text-gray-300" title={filePath}>
          {fileName}
        </span>

        {modified && <span className="shrink-0 text-primary-400 text-sm">{t('modified')}</span>}



        {mode === 'preview' && language === 'markdown' && (
          <button
            onClick={handleRefresh}
            className="hidden items-center gap-1 rounded-md border border-surface-600 bg-surface-800 px-2.5 py-1 text-sm font-medium text-gray-300 transition-colors hover:bg-surface-700 hover:text-white sm:inline-flex"
            title={t('reloadFile')}
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {t('refresh')}
          </button>
        )}

        {showDocumentControls && (
          <div className="hidden items-center overflow-hidden rounded-md border border-surface-700 bg-surface-800 text-sm sm:flex" title={t('documentWidthAndZoom')}>
            <button
              type="button"
              onClick={() => setDocumentZoom((z) => Math.max(0.85, Number((z - 0.1).toFixed(2))))}
              className="px-2 py-1 text-gray-300 hover:bg-surface-700 hover:text-white"
              title={t('zoomDocumentOut')}
            >
              −
            </button>
            <button
              type="button"
              onClick={() => setDocumentZoom(1)}
              className="border-l border-surface-700 px-2 py-1 text-gray-300 hover:bg-surface-700 hover:text-white tabular-nums"
              title={t('resetZoomTo100')}
            >
              {documentZoomPercent}%
            </button>
            <button
              type="button"
              onClick={() => setDocumentZoom((z) => Math.min(1.5, Number((z + 0.1).toFixed(2))))}
              className="border-l border-surface-700 px-2 py-1 text-gray-300 hover:bg-surface-700 hover:text-white"
              title={t('zoomDocumentIn')}
            >
              +
            </button>
            <select
              value={documentWidth}
              onChange={(e) => setDocumentWidth(e.target.value as DocumentWidthMode)}
              className="h-7 border-l border-surface-700 bg-surface-800 px-2 text-sm text-gray-200 outline-none"
              title={t('documentWidth')}
              aria-label={t('documentWidth')}
            >
              <option value="readable">{t('readableWidth')}</option>
              <option value="wide">{t('wideWidth')}</option>
              <option value="full">{t('fullWidth')}</option>
            </select>
          </div>
        )}

        {/* Mode toggle */}
        {hasPreview && !isBinary && (
          <>
            <div className="hidden bg-surface-800 rounded-md p-0.5 sm:flex">
              <button
                className={`px-2.5 py-1 text-sm rounded transition-colors ${mode === 'preview' ? 'bg-surface-700 text-white' : 'text-gray-400 hover:text-gray-300'}`}
                onClick={() => setMode('preview')}
                title={t('readAsDocument')}
              >
                {t('read')}
              </button>
              {language === 'markdown' ? (
                <>
                  <button
                    className={`px-2.5 py-1 text-sm rounded transition-colors ${mode === 'write' ? 'bg-surface-700 text-white' : 'text-gray-400 hover:text-gray-300'}`}
                    onClick={() => setMode('write')}
                    title={t('editMarkdownDocument')}
                  >
                    {t('edit')}
                  </button>
                  <button
                    className={`px-2.5 py-1 text-sm rounded transition-colors ${mode === 'split' ? 'bg-surface-700 text-white' : 'text-gray-400 hover:text-gray-300'}`}
                    onClick={() => setMode('split')}
                    title={t('previewWhileEditing')}
                  >
                    {t('split')}
                  </button>

                </>
              ) : (
                <button
                  className={`px-2.5 py-1 text-sm rounded transition-colors ${mode === 'source' ? 'bg-surface-700 text-white' : 'text-gray-400 hover:text-gray-300'}`}
                  onClick={() => setMode('source')}
                  title={t('editSource')}
                >
                  {t('source')}
                </button>
              )}
            </div>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as FileViewerMode)}
              className="h-8 w-[4.75rem] shrink-0 rounded-md border border-surface-700 bg-surface-800 px-1.5 text-xs text-gray-200 outline-none sm:hidden"
              title={t('viewMode')}
              aria-label={t('viewMode')}
            >
              <option value="preview">{t('read')}</option>
              {language === 'markdown' && <option value="write">{t('edit')}</option>}
              {language === 'markdown' && <option value="split">{t('split')}</option>}
              <option value="source">{t('source')}</option>
              {hasDirectEdit && <option value="edit">{t('quickEditBeta')}</option>}
            </select>
          </>
        )}
        {!hasPreview && !isBinary && (
          <span className="shrink-0 text-sm text-gray-500">{language}</span>
        )}

        {language === 'markdown' && (
          <FileActionsMenu>
              <MarkdownTtsControls content={content} className="w-full justify-start" />
              <button
                onClick={() => setShowShareModal(true)}
                className="rounded-md border border-primary-500/30 bg-primary-600/15 px-3 py-1.5 text-left text-sm font-medium text-primary-300 transition-colors hover:bg-primary-600/25 hover:text-primary-200"
                title={t('createExternalShareLink')}
              >
                {t('shareLink')}
              </button>
              <button className="rounded px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-surface-800" onClick={() => setMode('source')}>{t('viewSource')}</button>
              {hasDirectEdit && <button className="rounded px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-surface-800" onClick={() => setMode('edit')}>{t('quickEditBeta')}</button>}
              {mode === 'preview' && (
                <button
                  onClick={handleRefresh}
                  className="inline-flex items-center gap-1 rounded-md border border-surface-600 bg-surface-800 px-3 py-1.5 text-sm font-medium whitespace-nowrap text-gray-300 transition-colors hover:bg-surface-700 hover:text-white"
                  title={t('reloadFile')}
                >
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  {t('refresh')}
                </button>
              )}
          </FileActionsMenu>
        )}

        {modified && (
          <button
            onClick={() => handleSave()}
            className="shrink-0 text-sm px-3 py-1 bg-primary-600 hover:bg-primary-700 rounded transition-colors text-white"
          >
            {t('save')}
          </button>
        )}
      </div>

      {/* Content */}
      {mode === 'preview' && language === 'image' && <ImagePreview filePath={filePath} />}
      {mode === 'preview' && language === 'pdf' && <PdfPreview filePath={filePath} />}
      {mode === 'preview' && language === 'video' && <VideoPreview filePath={filePath} />}
      {mode === 'preview' && language === 'cad' && (
        <React.Suspense fallback={<div className="flex-1 flex items-center justify-center text-gray-400 text-base">{t('loadingCadViewer')}</div>}>
          <div className="flex-1 relative">
            <CadPreview filePath={filePath} />
          </div>
        </React.Suspense>
      )}
      {mode === 'preview' && isPricingAppFile(filePath) && <PricingFilePreview content={content} />}
      {mode === 'preview' && !isPricingAppFile(filePath) && CODE_PREVIEW_FORMATS.has(language) && (
        <div className="flex-1 min-h-0 overflow-hidden bg-surface-950">
          <CodeEditor value={content} language={language} readOnly formatForDisplay />
        </div>
      )}
      {mode === 'preview' && TEXT_PREVIEW_FORMATS.has(language) && <TextPreview content={content} language={language} selectableRef={textSelectableRef} />}
      {mode === 'preview' && language === 'html' && (
        <HtmlPreviewSurface content={content} filePath={filePath} className="flex-1 relative" />
      )}
      {mode === 'edit' && language === 'html' && hasDirectEdit && (
        <HtmlDirectEditSurface
          content={content}
          onContentChange={handlePreviewDirectEditChange}
          onSave={handleSave}
          className="flex-1 relative"
        />
      )}
      {mode === 'preview' && language === 'markdown' && (
        <div className="flex-1 overflow-y-auto bg-surface-950">
          <div className={`mx-auto w-full ${documentWidthClass} px-6 py-8 sm:px-8 lg:px-12`}>
            <div ref={mdSelectableRef} data-file-selectable-body="true" className="select-text">
              <MarkdownReadSurface
                content={content}
                components={mdComponents}
                className="prose prose-invert max-w-none markdown-document"
                style={{ fontSize: `${documentZoom}rem` }}
              />
            </div>
          </div>
        </div>
      )}
      {mode === 'edit' && language === 'markdown' && hasDirectEdit && (
        <div className="flex-1 overflow-y-auto bg-surface-950">
          <div className={`mx-auto w-full ${documentWidthClass} px-6 py-8 sm:px-8 lg:px-12`}>
            <MarkdownPreviewSurface
              content={content}
              filePath={filePath}
              components={mdComponents}
              onContentChange={handlePreviewDirectEditChange}
              inlineEditEnabled={false}
              previewDirectEditEnabled={true}
              inlineEditDisabled={loading}
              className="prose prose-invert max-w-none markdown-document"
              style={{ fontSize: `${documentZoom}rem` }}
            />
          </div>
        </div>
      )}
      {/* Office document previews (lazy-loaded) */}
      {mode === 'preview' && OFFICE_FORMATS.has(language) && (
        <React.Suspense fallback={
          <div className="flex-1 flex items-center justify-center text-gray-400 text-base">
            <svg className="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            {t('loadingViewer')}
          </div>
        }>
          {language === 'docx' && <DocxPreview filePath={filePath} />}
          {language === 'xlsx' && <XlsxPreview filePath={filePath} />}
          {language === 'pptx' && <PptxPreview filePath={filePath} />}
          {language === 'hwp' && <HwpPreview filePath={filePath} />}
        </React.Suspense>
      )}
      {/* SQLite preview (lazy-loaded) */}
      {mode === 'preview' && language === 'sqlite' && (
        <React.Suspense fallback={
          <div className="flex-1 flex items-center justify-center text-gray-400 text-base">
            <svg className="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            {t('loadingSqliteViewer')}
          </div>
        }>
          <SqlitePreview filePath={filePath} />
        </React.Suspense>
      )}
      {(mode === 'write' && language === 'markdown') && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <MarkdownEditor
            value={content}
            filePath={filePath}
            onChange={setContent}
            onSave={handleSave}
          />
        </div>
      )}
      {(mode === 'split' && language === 'markdown') && (
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 bg-surface-950">
          <div className="min-h-0 overflow-y-auto border-r border-surface-800">
            <MarkdownEditor
              value={content}
              filePath={filePath}
              onChange={setContent}
              onSave={handleSave}
            />
          </div>
          <div className="min-h-0 overflow-y-auto px-6 py-8">
            <MarkdownReadSurface
              content={content}
              components={mdComponents}
              className="prose prose-invert prose-sm max-w-none markdown-document"
            />
          </div>
        </div>
      )}
      {(mode === 'source' || (!hasPreview && !isBinary)) && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <CodeEditor
            value={content}
            language={language}
            onChange={setContent}
            onSave={handleSave}
          />
        </div>
      )}
    </div>
  );
}
