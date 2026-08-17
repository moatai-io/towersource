// Owns: pure HTML iframe preview without AI inline-edit injection. Public API: HtmlPreviewSurface.
// Used when INLINE_EDIT_ENABLED is off so the preserved inline-edit module is
// completely bypassed for normal preview rendering.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  content: string;
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

export function HtmlPreviewSurface({ content, className }: Props) {
  const { t } = useTranslation('files');
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [zoomMode, setZoomMode] = useState<'fit' | 'custom'>('fit');
  const [zoom, setZoom] = useState(1);
  const canvas = useMemo(() => detectCanvasSize(content), [content]);
  const blobUrl = useMemo(() => {
    const blob = new Blob([content], { type: 'text/html' });
    return URL.createObjectURL(blob);
  }, [content]);

  useEffect(() => {
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

  const padding = 32;
  const fitScale = canvas ? Math.min(Math.max((containerWidth - padding) / canvas.width, 0.1), 1) : 1;
  const clampZoom = (value: number) => Math.min(3, Math.max(0.25, value));
  const scale = canvas && zoomMode === 'fit' ? fitScale : zoom;
  const setCustomZoom = (next: number) => {
    setZoom(clampZoom(next));
    setZoomMode('custom');
  };

  if (!canvas) {
    return (
      <div className={className ?? 'absolute inset-0'}>
        <iframe
          src={blobUrl}
          className="w-full h-full border-0 bg-white"
          sandbox="allow-scripts allow-same-origin"
          title="html-preview"
        />
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`${className ?? 'absolute inset-0'} overflow-auto bg-surface-950`}>
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-3 py-2 border-b border-surface-800/80 bg-surface-950/90 backdrop-blur">
        <div className="text-sm text-gray-400">Canvas {canvas.width}×{canvas.height} · {Math.round(scale * 100)}%</div>
        <div className="flex items-center overflow-hidden rounded-lg border border-surface-700/60 bg-surface-900/80 text-sm">
          <button
            type="button"
            onClick={() => setCustomZoom(scale / 1.2)}
            className="px-2.5 py-1.5 text-gray-300 hover:bg-surface-800 hover:text-white"
            title={t('zoomOut')}
          >
            −
          </button>
          <button
            type="button"
            onClick={() => setZoomMode('fit')}
            className={`border-l border-surface-700/60 px-2.5 py-1.5 ${zoomMode === 'fit' ? 'bg-primary-500/20 text-primary-300' : 'text-gray-400 hover:bg-surface-800 hover:text-gray-200'}`}
          >
            {t('fit')}
          </button>
          <button
            type="button"
            onClick={() => setCustomZoom(1)}
            className={`border-l border-surface-700/60 px-2.5 py-1.5 ${zoomMode === 'custom' && Math.abs(zoom - 1) < 0.01 ? 'bg-primary-500/20 text-primary-300' : 'text-gray-400 hover:bg-surface-800 hover:text-gray-200'}`}
          >
            100%
          </button>
          <button
            type="button"
            onClick={() => setCustomZoom(scale * 1.2)}
            className="border-l border-surface-700/60 px-2.5 py-1.5 text-gray-300 hover:bg-surface-800 hover:text-white"
            title={t('zoomIn')}
          >
            +
          </button>
        </div>
      </div>
      <div className="p-4">
        <div
          className="mx-auto shadow-2xl shadow-black/40"
          style={{ width: canvas.width * scale, height: canvas.height * scale }}
        >
          <iframe
            src={blobUrl}
            className="block border-0 bg-white"
            sandbox="allow-scripts allow-same-origin"
            title="html-preview"
            style={{
              width: canvas.width,
              height: canvas.height,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          />
        </div>
      </div>
    </div>
  );
}
