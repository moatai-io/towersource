import React, { useEffect, useMemo, useRef, useState } from 'react';

type BoundsTuple = [number, number, number, number];

type CadPrimitive = {
  id: string;
  kind: 'line' | 'polyline' | 'circle' | 'arc' | 'text' | string;
  entityId?: string;
  handle?: string | null;
  layer?: string;
  bbox?: BoundsTuple;
  points?: number[][];
  center?: number[];
  radius?: number;
  position?: number[];
  text?: string;
  height?: number;
};

type CadGeometryManifest = {
  schema?: string;
  sourcePath?: string;
  bounds?: BoundsTuple;
  overview?: { file: string; primitiveCount?: number; bytes?: number };
  tiles?: Array<{ file: string; primitiveCount?: number; bytes?: number; bounds?: BoundsTuple }>;
};

type CadGeometryPayload = {
  primitives?: CadPrimitive[];
};

type CadGeometrySelectionDetail = {
  path: string;
  cadGeometryManifestPath: string;
  selection: {
    type: 'entity';
    primitiveId: string;
    entityId?: string;
    handle?: string;
    layer?: string;
    bounds?: BoundsTuple;
    lookup: 'geometry-tile';
  };
};

interface CadGeometryCanvasLayerProps {
  manifestPath: string;
  filePath: string;
  token?: string;
  enabled: boolean;
  onSelectionChange?: (detail: CadGeometrySelectionDetail) => void;
}

const authHeaders = (token?: string) => token ? { Authorization: `Bearer ${token}` } : undefined;
const serveUrl = (path: string, token?: string) => `/api/files/serve?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token || '')}`;
const dirname = (p: string) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const joinManifestRelative = (manifestPath: string, relative: string) => `${dirname(manifestPath)}/${relative}`;

function layerColor(layer?: string) {
  const palette = ['#60a5fa', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#22d3ee', '#fb7185', '#94a3b8'];
  let hash = 0;
  for (const ch of String(layer || '0')) hash = ((hash * 31) + ch.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

function distancePointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function CadGeometryCanvasLayer({ manifestPath, filePath, token, enabled, onSelectionChange }: CadGeometryCanvasLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [manifest, setManifest] = useState<CadGeometryManifest | null>(null);
  const [overview, setOverview] = useState<CadPrimitive[]>([]);
  const [detailPrimitives, setDetailPrimitives] = useState<CadPrimitive[]>([]);
  const [error, setError] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string>('');

  const bounds = manifest?.bounds;
  const primitives = detailPrimitives.length ? detailPrimitives : overview;

  useEffect(() => {
    if (!enabled || !manifestPath) return;
    let cancelled = false;
    setError('');
    setManifest(null);
    setOverview([]);
    setDetailPrimitives([]);
    setSelectedId('');

    async function loadJson<T>(path: string): Promise<T> {
      const res = await fetch(serveUrl(path, token), { headers: authHeaders(token) });
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return await res.json() as T;
    }

    (async () => {
      const nextManifest = await loadJson<CadGeometryManifest>(manifestPath);
      if (cancelled) return;
      setManifest(nextManifest);
      if (nextManifest.overview?.file) {
        const overviewPath = joinManifestRelative(manifestPath, nextManifest.overview.file);
        const overviewPayload = await loadJson<CadGeometryPayload>(overviewPath);
        if (!cancelled) setOverview(Array.isArray(overviewPayload.primitives) ? overviewPayload.primitives : []);
      }
      const firstTile = nextManifest.tiles?.[0];
      if (firstTile?.file) {
        const tilePath = joinManifestRelative(manifestPath, firstTile.file);
        const tilePayload = await loadJson<CadGeometryPayload>(tilePath);
        if (!cancelled) setDetailPrimitives(Array.isArray(tilePayload.primitives) ? tilePayload.primitives : []);
      }
    })().catch((err) => {
      if (!cancelled) setError(err.message || 'CAD geometry layer failed');
    });

    return () => { cancelled = true; };
  }, [enabled, manifestPath, token]);

  const transform = useMemo(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bounds) return null;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width * dpr);
    const height = Math.max(1, rect.height * dpr);
    const modelW = Math.max(1, bounds[2] - bounds[0]);
    const modelH = Math.max(1, bounds[3] - bounds[1]);
    const baseScale = Math.min(width / modelW, height / modelH) * 0.9;
    return {
      dpr,
      width,
      height,
      scale: baseScale,
      offsetX: (width - modelW * baseScale) / 2,
      offsetY: (height - modelH * baseScale) / 2,
    };
  }, [bounds, primitives.length]);

  const sx = (x: number, t = transform) => !bounds || !t ? 0 : t.offsetX + (x - bounds[0]) * t.scale;
  const sy = (y: number, t = transform) => !bounds || !t ? 0 : t.offsetY + (bounds[3] - y) * t.scale;

  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas || !bounds || !transform) return;
    canvas.width = transform.width;
    canvas.height = transform.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of primitives) {
      ctx.save();
      ctx.strokeStyle = p.id === selectedId ? '#22d3ee' : layerColor(p.layer);
      ctx.fillStyle = p.id === selectedId ? '#22d3ee' : 'rgba(226,232,240,.82)';
      ctx.lineWidth = p.id === selectedId ? 3 : 1.2;
      if (p.kind === 'line' && p.points?.[0] && p.points?.[1]) {
        ctx.beginPath(); ctx.moveTo(sx(p.points[0][0]), sy(p.points[0][1])); ctx.lineTo(sx(p.points[1][0]), sy(p.points[1][1])); ctx.stroke();
      } else if (p.kind === 'polyline' && p.points?.length) {
        ctx.beginPath(); p.points.forEach((pt, i) => i ? ctx.lineTo(sx(pt[0]), sy(pt[1])) : ctx.moveTo(sx(pt[0]), sy(pt[1]))); ctx.stroke();
      } else if ((p.kind === 'circle' || p.kind === 'arc') && p.center && typeof p.radius === 'number') {
        ctx.beginPath(); ctx.arc(sx(p.center[0]), sy(p.center[1]), Math.max(1, p.radius * transform.scale), 0, Math.PI * 2); ctx.stroke();
      } else if (p.kind === 'text' && p.position) {
        ctx.font = `${Math.max(8, Math.min(24, (p.height || 100) * transform.scale))}px sans-serif`;
        ctx.fillText(p.text || '', sx(p.position[0]), sy(p.position[1]));
      }
      ctx.restore();
    }
  }, [enabled, bounds, transform, primitives, selectedId]);

  const hitTest = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !transform) return null;
    const rect = canvas.getBoundingClientRect();
    const px = (clientX - rect.left) * transform.dpr;
    const py = (clientY - rect.top) * transform.dpr;
    let best: CadPrimitive | null = null;
    let bestD = 10;
    for (const p of primitives) {
      if (p.kind === 'line' && p.points?.[0] && p.points?.[1]) {
        const d = distancePointToSegment(px, py, sx(p.points[0][0]), sy(p.points[0][1]), sx(p.points[1][0]), sy(p.points[1][1]));
        if (d < bestD) { bestD = d; best = p; }
      } else if (p.kind === 'polyline' && p.points?.length) {
        for (let i = 1; i < p.points.length; i++) {
          const a = p.points[i - 1];
          const b = p.points[i];
          const d = distancePointToSegment(px, py, sx(a[0]), sy(a[1]), sx(b[0]), sy(b[1]));
          if (d < bestD) { bestD = d; best = p; }
        }
      } else if ((p.kind === 'circle' || p.kind === 'arc') && p.center && typeof p.radius === 'number') {
        const d = Math.abs(Math.hypot(px - sx(p.center[0]), py - sy(p.center[1])) - p.radius * transform.scale);
        if (d < bestD) { bestD = d; best = p; }
      }
    }
    return best;
  };

  if (!enabled || !manifestPath) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      <canvas
        ref={canvasRef}
        className="h-full w-full opacity-80 mix-blend-screen"
        onClick={(event) => {
          const hit = hitTest(event.clientX, event.clientY);
          if (!hit) return;
          setSelectedId(hit.id);
          onSelectionChange?.({
            path: filePath,
            cadGeometryManifestPath: manifestPath,
            selection: {
              type: 'entity',
              primitiveId: hit.id,
              entityId: hit.entityId,
              handle: hit.handle || undefined,
              layer: hit.layer,
              bounds: hit.bbox,
              lookup: 'geometry-tile',
            },
          });
        }}
        style={{ pointerEvents: 'auto' }}
      />
      <div className="pointer-events-none absolute left-2 top-2 rounded bg-slate-950/80 px-2 py-1 text-[10px] font-medium text-cyan-100 shadow">
        geometry {detailPrimitives.length || overview.length}{error ? ` · ${error}` : ''}
      </div>
    </div>
  );
}
