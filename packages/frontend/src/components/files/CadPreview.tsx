import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface CadBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface CadViewCandidate {
  id: string;
  label: string;
  kind: 'overview' | 'layout' | 'view' | 'title-block' | 'table' | 'detail';
  bbox: CadBBox;
  entityCount: number;
  score: number;
}

interface CadMetadata {
  cadPath: string;
  fileSize: number;
  layouts: Array<{ name: string; entityCount: number }>;
  layers: Array<{ name: string; entityCount: number; color?: number }>;
  entityTypes: Record<string, number>;
  overallBBox?: CadBBox;
  candidates: CadViewCandidate[];
  notes: string[];
}

type CadRenderMode = 'dark' | 'light' | 'mono';

const formatNumber = (value: number) => new Intl.NumberFormat().format(Math.round(value));
const bboxToParam = (bbox?: CadBBox) => bbox ? `${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY}` : '';
const bboxSizeLabel = (bbox?: CadBBox) => bbox ? `${formatNumber(bbox.maxX - bbox.minX)} × ${formatNumber(bbox.maxY - bbox.minY)}` : '—';
const fileSizeLabel = (bytes?: number) => typeof bytes === 'number' ? `${(bytes / 1024 / 1024).toFixed(bytes > 1024 * 1024 ? 1 : 2)} MB` : '—';

/** Basic CAD preview. Advanced QA/evidence/geometry Workbench features were retired. */
export function CadPreview({ filePath }: { filePath: string }) {
  const { t } = useTranslation('files');
  const [metadata, setMetadata] = useState<CadMetadata | null>(null);
  const [metadataError, setMetadataError] = useState('');
  const [selectedCandidate, setSelectedCandidate] = useState<CadViewCandidate | null>(null);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [renderMode, setRenderMode] = useState<CadRenderMode>('dark');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);

  const selectedBBox = selectedCandidate?.kind === 'overview' ? undefined : selectedCandidate?.bbox;
  const renderBackground = renderMode === 'dark' ? 'black' : 'white';
  const renderMonochrome = renderMode === 'mono';
  const topEntityTypes = useMemo(() => Object.entries(metadata?.entityTypes || {}).sort((a, b) => b[1] - a[1]).slice(0, 8), [metadata]);

  useEffect(() => {
    let cancelled = false;
    const token = localStorage.getItem('token') || '';
    const params = new URLSearchParams({ path: filePath, token });
    setMetadata(null);
    setMetadataError('');
    setSelectedCandidate(null);
    fetch(`/api/files/cad-metadata?${params.toString()}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
      .then(async (res) => {
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
        return payload as CadMetadata;
      })
      .then((payload) => {
        if (cancelled) return;
        setMetadata(payload);
        setSelectedCandidate(payload.candidates?.[0] || null);
      })
      .catch((err) => { if (!cancelled) setMetadataError(err.message || 'CAD metadata failed'); });
    return () => { cancelled = true; };
  }, [filePath]);

  useEffect(() => {
    if (!metadata) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    const token = localStorage.getItem('token') || '';
    setStatus('loading');
    setError('');
    setZoom(1);
    setPan({ x: 0, y: 0 });

    const load = async () => {
      const params = new URLSearchParams({
        path: filePath,
        width: selectedBBox ? '1600' : '2400',
        height: selectedBBox ? '1200' : '1800',
        background: renderBackground,
        token,
      });
      if (renderMonochrome) params.set('monochrome', 'true');
      if (selectedBBox) params.set('bbox', bboxToParam(selectedBBox));
      const res = await fetch(`/api/files/cad-preview?${params.toString()}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      return res.blob();
    };

    load().then((blob) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setBlobUrl(objectUrl);
      setStatus('loaded');
    }).catch((err) => {
      if (cancelled) return;
      setError(err.message || 'Failed to render CAD preview');
      setStatus('error');
    });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [filePath, metadata, renderBackground, renderMonochrome, selectedBBox]);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const zoomBy = useCallback((factor: number) => {
    setZoom((current) => Math.min(8, Math.max(0.2, current * factor)));
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!blobUrl) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerRef.current = { x: event.clientX, y: event.clientY };
    setIsPanning(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isPanning || !pointerRef.current) return;
    const dx = event.clientX - pointerRef.current.x;
    const dy = event.clientY - pointerRef.current.y;
    pointerRef.current = { x: event.clientX, y: event.clientY };
    setPan((current) => ({ x: current.x + dx, y: current.y + dy }));
  };

  const stopPanning = () => {
    pointerRef.current = null;
    setIsPanning(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-950 text-slate-100">
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-2 text-xs">
        <span className="font-semibold">CAD Preview</span>
        <span className="text-slate-400">{filePath.split('/').pop()}</span>
        <div className="ml-auto flex items-center gap-1">
          {(['dark', 'light', 'mono'] as CadRenderMode[]).map((mode) => (
            <button key={mode} type="button" onClick={() => setRenderMode(mode)} className={`rounded px-2 py-1 ${renderMode === mode ? 'bg-primary-600 text-white' : 'bg-slate-800 text-slate-300'}`}>{mode}</button>
          ))}
          <button type="button" onClick={() => zoomBy(1.2)} className="rounded bg-slate-800 px-2 py-1">+</button>
          <button type="button" onClick={() => zoomBy(1 / 1.2)} className="rounded bg-slate-800 px-2 py-1">−</button>
          <button type="button" onClick={resetView} className="rounded bg-slate-800 px-2 py-1">{Math.round(zoom * 100)}%</button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 overflow-auto border-r border-slate-800 p-3 text-xs">
          {metadataError && <p className="text-red-300">{metadataError}</p>}
          {metadata && (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-slate-300">
                <dt>{t('cad.fileSize')}</dt><dd>{fileSizeLabel(metadata.fileSize)}</dd>
                <dt>{t('cad.bounds')}</dt><dd>{bboxSizeLabel(metadata.overallBBox)}</dd>
                <dt>{t('cad.layers')}</dt><dd>{metadata.layers.length}</dd>
              </dl>
              <h3 className="mt-4 font-semibold text-slate-200">{t('cad.views')}</h3>
              <div className="mt-2 space-y-1">
                {(metadata.candidates || []).map((candidate) => (
                  <button key={candidate.id} type="button" onClick={() => setSelectedCandidate(candidate)} className={`w-full rounded px-2 py-2 text-left ${selectedCandidate?.id === candidate.id ? 'bg-primary-600/30 text-primary-100' : 'bg-slate-900 hover:bg-slate-800'}`}>
                    <div className="font-medium">{candidate.label}</div>
                    <div className="mt-0.5 text-[10px] text-slate-400">{candidate.kind} · {formatNumber(candidate.entityCount)}</div>
                  </button>
                ))}
              </div>
              {topEntityTypes.length > 0 && (
                <>
                  <h3 className="mt-4 font-semibold text-slate-200">{t('cad.entityTypes')}</h3>
                  <ul className="mt-2 space-y-1 text-slate-400">
                    {topEntityTypes.map(([name, count]) => <li key={name} className="flex justify-between"><span>{name}</span><span>{formatNumber(count)}</span></li>)}
                  </ul>
                </>
              )}
            </>
          )}
        </aside>

        <div
          ref={viewportRef}
          className={`relative min-w-0 flex-1 overflow-hidden ${renderMode === 'dark' ? 'bg-slate-950' : 'bg-slate-100'} ${isPanning ? 'cursor-grabbing' : 'cursor-grab'}`}
          onWheel={(event) => { event.preventDefault(); zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12); }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopPanning}
          onPointerCancel={stopPanning}
        >
          {status === 'loading' && <div className="absolute inset-0 grid place-items-center text-sm text-slate-400">{t('cad.render.preparing')}</div>}
          {status === 'error' && <div className="absolute inset-0 grid place-items-center p-6 text-sm text-red-300">{error}</div>}
          {blobUrl && (
            <div className="absolute inset-0 grid place-items-center" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'center' }}>
              <img src={blobUrl} alt={t('cad.previewAlt', { defaultValue: 'CAD 도면 미리보기' })} draggable={false} className="max-h-full max-w-full select-none object-contain" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
