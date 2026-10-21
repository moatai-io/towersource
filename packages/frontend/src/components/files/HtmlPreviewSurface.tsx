// Owns: HTML iframe preview and source-backed static HTML inspection.
// Public API: HtmlPreviewSurface.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toastError, toastSuccess } from '../../utils/toast';
import { buildHtmlSourceInspectorDocument, type HtmlSourceAnchor } from './source-inspector/htmlSourceAnchors';
import { dispatchComposerSourceReference } from './source-inspector/sourceReference';

interface Props {
  content: string;
  filePath?: string;
  className?: string;
}

function detectCanvasSize(html: string): { width: number; height: number } | null {
  const meta = html.match(/<meta\s+[^>]*name=["']tower:canvas["'][^>]*content=["'](\d+)\s*x\s*(\d+)["'][^>]*>/i)
    || html.match(/data-tower-canvas=["'](\d+)\s*x\s*(\d+)["']/i);
  if (meta) return { width: Number(meta[1]), height: Number(meta[2]) };

  const page = html.match(/@page\s*\{[^}]*size\s*:\s*(\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px/i);
  if (page) return { width: Number(page[1]), height: Number(page[2]) };

  const slide = html.match(/\.slide\s*\{[^}]*width\s*:\s*(\d+(?:\.\d+)?)px[^}]*height\s*:\s*(\d+(?:\.\d+)?)px/i);
  if (slide) return { width: Number(slide[1]), height: Number(slide[2]) };

  return null;
}

function makeInspectorNonce(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function HtmlPreviewSurface({ content, filePath, className }: Props) {
  const { t } = useTranslation('files');
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const nonceRef = useRef(makeInspectorNonce());
  const [containerWidth, setContainerWidth] = useState(0);
  const [zoomMode, setZoomMode] = useState<'fit' | 'custom'>('fit');
  const [zoom, setZoom] = useState(1);
  const [inspectorEnabled, setInspectorEnabled] = useState(false);
  const [inspectorReady, setInspectorReady] = useState(false);
  const [selectedAnchor, setSelectedAnchor] = useState<HtmlSourceAnchor | null>(null);
  const canvas = useMemo(() => detectCanvasSize(content), [content]);
  const inspectorDocument = useMemo(
    () => buildHtmlSourceInspectorDocument(content, nonceRef.current),
    [content],
  );
  const anchorsById = useMemo(
    () => new Map(inspectorDocument.anchors.map((anchor) => [anchor.id, anchor])),
    [inspectorDocument.anchors],
  );
  const blobUrl = useMemo(() => {
    const blob = new Blob([inspectorDocument.html], { type: 'text/html' });
    return URL.createObjectURL(blob);
  }, [inspectorDocument.html]);

  useEffect(() => {
    setInspectorReady(false);
    setSelectedAnchor(null);
    return () => {
      try { URL.revokeObjectURL(blobUrl); } catch { /* no-op */ }
    };
  }, [blobUrl]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data;
      if (!data || data.nonce !== nonceRef.current || typeof data.type !== 'string') return;
      if (data.type === 'tower-html-source-ready') {
        setInspectorReady(true);
        return;
      }
      if (data.type === 'tower-html-source-exit') {
        setInspectorEnabled(false);
        return;
      }
      if (data.type !== 'tower-html-source-select' || typeof data.anchorId !== 'string') return;
      const anchor = anchorsById.get(data.anchorId);
      if (!anchor || !filePath) return;
      setSelectedAnchor(anchor);
      if (filePath) {
        dispatchComposerSourceReference({
          version: 1,
          id: `${filePath}:${anchor.start}:${anchor.end}`,
          path: filePath,
          language: 'html',
          kind: 'element',
          tagName: anchor.tagName,
          start: anchor.start,
          end: anchor.end,
          lineStart: anchor.lineStart,
          lineEnd: anchor.lineEnd,
          source: anchor.source,
          confidence: 'exact',
          mappingProvider: 'html-parser',
        });
        toastSuccess(t('htmlPreview.sourceAttached', { defaultValue: '소스 참조를 대화에 첨부했습니다.' }));
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [anchorsById, filePath]);

  useEffect(() => {
    if (!inspectorReady) return;
    iframeRef.current?.contentWindow?.postMessage({
      type: inspectorEnabled
        ? 'tower-html-source-inspector-enable'
        : 'tower-html-source-inspector-disable',
      nonce: nonceRef.current,
    }, '*');
  }, [inspectorEnabled, inspectorReady]);

  const padding = 32;
  const fitScale = canvas ? Math.min(Math.max((containerWidth - padding) / canvas.width, 0.1), 1) : 1;
  const clampZoom = (value: number) => Math.min(3, Math.max(0.25, value));
  const scale = canvas && zoomMode === 'fit' ? fitScale : zoom;
  const setCustomZoom = (next: number) => {
    setZoom(clampZoom(next));
    setZoomMode('custom');
  };

  const attachSelectedToChat = () => {
    if (!filePath || !selectedAnchor) return;
    dispatchComposerSourceReference({
      version: 1,
      id: `${filePath}:${selectedAnchor.start}:${selectedAnchor.end}`,
      path: filePath,
      language: 'html',
      kind: 'element',
      tagName: selectedAnchor.tagName,
      start: selectedAnchor.start,
      end: selectedAnchor.end,
      lineStart: selectedAnchor.lineStart,
      lineEnd: selectedAnchor.lineEnd,
      source: selectedAnchor.source,
      confidence: 'exact',
      mappingProvider: 'html-parser',
    });
    toastSuccess(t('htmlPreview.sourceAttached', { defaultValue: '소스 참조를 대화에 첨부했습니다.' }));
  };

  const inspectorControls = filePath ? (
    <div className="pointer-events-auto absolute right-3 top-3 z-20 flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-lg border border-surface-700/80 bg-surface-950/90 p-1.5 shadow-xl backdrop-blur">
      {selectedAnchor && (
        <>
          <span className="min-w-0 truncate px-1.5 font-mono text-xs text-primary-200" title={`${filePath}:L${selectedAnchor.lineStart}-L${selectedAnchor.lineEnd}`}>
            &lt;{selectedAnchor.tagName}&gt; · L{selectedAnchor.lineStart}–L{selectedAnchor.lineEnd}
          </span>
          <button type="button" onClick={attachSelectedToChat} className="shrink-0 rounded-md bg-surface-800 px-2 py-1.5 text-xs font-semibold text-surface-200 hover:bg-surface-700">
            {t('htmlPreview.attachAgain', { defaultValue: '다시 첨부' })}
          </button>
        </>
      )}
      <button
        type="button"
        onClick={() => setInspectorEnabled((value) => !value)}
        disabled={!inspectorReady || inspectorDocument.anchors.length === 0}
        className={`shrink-0 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          inspectorEnabled
            ? 'bg-primary-600 text-white hover:bg-primary-500'
            : 'bg-surface-800 text-surface-200 hover:bg-surface-700'
        }`}
        title={t('htmlPreview.inspectHelp', { defaultValue: '화면의 요소를 클릭하면 정확한 정적 HTML 소스 범위를 대화에 첨부합니다.' })}
      >
        {inspectorEnabled ? t('htmlPreview.inspectingSource', { defaultValue: '소스를 선택하는 중' }) : t('htmlPreview.inspectSource', { defaultValue: '소스 선택' })}
      </button>
    </div>
  ) : null;

  const iframe = (
    <iframe
      ref={iframeRef}
      src={blobUrl}
      className={canvas ? 'block border-0 bg-white' : 'h-full w-full border-0 bg-white'}
      sandbox="allow-scripts allow-same-origin"
      title="html-preview"
      style={canvas ? {
        width: canvas.width,
        height: canvas.height,
        transform: `scale(${scale})`,
        transformOrigin: 'top left',
      } : undefined}
    />
  );

  if (!canvas) {
    return (
      <div ref={containerRef} className={`${className ?? 'absolute inset-0'} overflow-hidden`}>
        {inspectorControls}
        {iframe}
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`${className ?? 'absolute inset-0'} overflow-auto bg-surface-950`}>
      {inspectorControls}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-surface-800/80 bg-surface-950/90 px-3 py-2 backdrop-blur">
        <div className="text-sm text-gray-400">Canvas {canvas.width}×{canvas.height} · {Math.round(scale * 100)}%</div>
        <div className="flex items-center overflow-hidden rounded-lg border border-surface-700/60 bg-surface-900/80 text-sm">
          <button type="button" onClick={() => setCustomZoom(scale / 1.2)} className="px-2.5 py-1.5 text-gray-300 hover:bg-surface-800 hover:text-white" title={t('zoomOut')}>−</button>
          <button type="button" onClick={() => setZoomMode('fit')} className={`border-l border-surface-700/60 px-2.5 py-1.5 ${zoomMode === 'fit' ? 'bg-primary-500/20 text-primary-300' : 'text-gray-400 hover:bg-surface-800 hover:text-gray-200'}`}>{t('fit')}</button>
          <button type="button" onClick={() => setCustomZoom(1)} className={`border-l border-surface-700/60 px-2.5 py-1.5 ${zoomMode === 'custom' && Math.abs(zoom - 1) < 0.01 ? 'bg-primary-500/20 text-primary-300' : 'text-gray-400 hover:bg-surface-800 hover:text-gray-200'}`}>100%</button>
          <button type="button" onClick={() => setCustomZoom(scale * 1.2)} className="border-l border-surface-700/60 px-2.5 py-1.5 text-gray-300 hover:bg-surface-800 hover:text-white" title={t('zoomIn')}>+</button>
        </div>
      </div>
      <div className="p-4">
        <div className="mx-auto shadow-2xl shadow-black/40" style={{ width: canvas.width * scale, height: canvas.height * scale }}>
          {iframe}
        </div>
      </div>
    </div>
  );
}
