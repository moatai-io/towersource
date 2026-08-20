import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useAiPanelStore } from '../../stores/ai-panel-store';
import { CadGeometryCanvasLayer } from './CadGeometryCanvasLayer';

interface CadEvidenceFocusDetail {
  label?: string;
  primitiveId?: string;
  entityId?: string;
  textId?: string;
  blockInstanceId?: string;
  semanticObjectId?: string;
  cadModelArtifactPath?: string;
  handle?: string;
  layer?: string;
  block?: string;
  text?: string;
  insert?: number[];
  bounds?: number[];
  confidence?: string;
  note?: string;
}

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

type CadSelectionKind = 'view-candidate' | 'evidence' | 'entity' | 'area' | 'semantic-object';
type CadEvidenceLookupKind = 'text' | 'block' | 'entity' | 'semantic' | 'miss' | 'none' | 'geometry' | 'geometry-tile';
type CadRenderMode = 'dark' | 'light' | 'mono';

type CadBoundsTuple = [number, number, number, number];

interface CadSelectionChangeDetail {
  path: string;
  cadModelArtifactPath?: string;
  cadGeometryManifestPath?: string;
  view?: {
    candidateId?: string;
    viewId?: string;
    label?: string;
    kind?: CadViewCandidate['kind'];
    bbox?: CadBBox;
  };
  viewport?: {
    zoom: number;
    pan: { x: number; y: number };
  };
  selection: {
    type: CadSelectionKind;
    primitiveId?: string;
    entityId?: string;
    textId?: string;
    blockInstanceId?: string;
    semanticObjectId?: string;
    cadModelArtifactPath?: string;
    cadGeometryManifestPath?: string;
    handle?: string;
    block?: string;
    layer?: string;
    bounds?: CadBoundsTuple;
    insert?: number[];
    label?: string;
    text?: string;
    confidence?: string;
    lookup?: CadEvidenceLookupKind;
  };
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

interface CadTextIndexItem {
  id?: string;
  entityId?: string;
  handle?: string;
  layer?: string;
  text?: string;
  insert?: number[];
  bounds?: number[];
  height?: number;
}

interface CadTextIndexPayload {
  texts?: CadTextIndexItem[];
}

interface CadBlockIndexItem {
  id?: string;
  entityId?: string;
  handle?: string;
  block?: string;
  blockName?: string;
  name?: string;
  layer?: string;
  insert?: number[];
  bounds?: number[];
  attributes?: Record<string, string>;
  rotation?: number;
}

interface CadSemanticObjectItem {
  id?: string;
  kind?: string;
  label?: string;
  entityIds?: string[];
  handle?: string;
  layer?: string;
  blockName?: string;
  block?: string;
  text?: string;
  insert?: number[];
  bounds?: number[];
  confidence?: number | string;
}

interface CadModelPayload {
  schema?: string;
  bounds?: number[];
  texts?: CadTextIndexItem[];
  blockInstances?: CadBlockIndexItem[];
  semanticObjects?: CadSemanticObjectItem[];
}

interface CadGeometryManifestPayload {
  schema?: string;
  version?: string;
  bounds?: CadBoundsTuple;
  counts?: {
    topLevelEntities?: number;
    primitives?: number;
    unsupported?: number;
    layers?: number;
    tiles?: number;
    overviewPrimitives?: number;
  };
  primitiveKindCounts?: Record<string, number>;
  unsupportedTypeCounts?: Record<string, number>;
  overview?: { file: string; primitiveCount?: number; bytes?: number };
  tiles?: Array<{ file: string; primitiveCount?: number; bytes?: number; bounds?: CadBoundsTuple }>;
  tileStats?: {
    maxTileBytes?: number;
    avgTileBytes?: number;
    maxPrimitiveCount?: number;
  };
}

interface CadBlockIndexPayload {
  blocks?: CadBlockIndexItem[];
}

type CadEvidenceLookupItem = CadTextIndexItem | CadBlockIndexItem | CadSemanticObjectItem;

interface CadQaResult {
  ok: boolean;
  status?: string | null;
  warnings?: string[];
  artifacts?: {
    dir: string;
    qa: string;
    source: string;
    previewFull: string;
    previewContent: string;
    aiBrief?: string;
    textIndex?: string;
    layerSummary?: string;
    blockIndex?: string;
    candidateReport?: string;
    cadModel?: string;
    cadGeometryManifest?: string;
    cadGeometryOverview?: string;
    cadGeometryUnsupportedSummary?: string;
    candidateReportMd?: string;
    rfqIntake?: string;
  };
  qa?: {
    bounds?: { modelspace?: number[] };
    visual_metrics?: Record<string, any>;
    inspect?: Record<string, any>;
  };
}

const formatNumber = (value: number) => new Intl.NumberFormat().format(Math.round(value));
const bboxToParam = (bbox?: CadBBox) => bbox ? `${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY}` : '';
const bboxSizeLabel = (bbox?: CadBBox) => bbox ? `${formatNumber(bbox.maxX - bbox.minX)} × ${formatNumber(bbox.maxY - bbox.minY)}` : '—';
const fileSizeLabel = (bytes?: number) => typeof bytes === 'number' ? `${(bytes / 1024 / 1024).toFixed(bytes > 1024 * 1024 ? 1 : 2)} MB` : '—';
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const bboxToList = (bbox?: CadBBox | null): CadBoundsTuple | undefined => bbox ? [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY] : undefined;

function evidenceLookupKind(hit: CadEvidenceLookupItem | null): 'text' | 'block' | 'semantic' | 'none' {
  if (!hit) return 'none';
  if ('kind' in hit && ('entityIds' in hit || 'label' in hit)) return 'semantic';
  return 'block' in hit || 'blockName' in hit || 'attributes' in hit ? 'block' : 'text';
}

function cadModelLookup(item: CadEvidenceFocusDetail, cadModel?: CadModelPayload | null): CadEvidenceLookupItem | null {
  if (!cadModel) return null;
  if (item.semanticObjectId) {
    const hit = cadModel.semanticObjects?.find((entry) => entry.id === item.semanticObjectId);
    if (hit) return hit;
  }
  if (item.entityId) {
    const semanticHit = cadModel.semanticObjects?.find((entry) => entry.entityIds?.includes(item.entityId || ''));
    if (semanticHit) return semanticHit;
    const textHit = cadModel.texts?.find((entry) => entry.entityId === item.entityId);
    if (textHit) return textHit;
    const blockHit = cadModel.blockInstances?.find((entry) => entry.entityId === item.entityId);
    if (blockHit) return blockHit;
  }
  if (item.textId) {
    const hit = cadModel.texts?.find((entry) => entry.id === item.textId);
    if (hit) return hit;
  }
  if (item.blockInstanceId) {
    const hit = cadModel.blockInstances?.find((entry) => entry.id === item.blockInstanceId);
    if (hit) return hit;
  }
  if (item.handle) {
    const handle = item.handle.toLowerCase();
    const semanticHit = cadModel.semanticObjects?.find((entry) => entry.handle?.toLowerCase() === handle);
    if (semanticHit) return semanticHit;
    const textHit = cadModel.texts?.find((entry) => entry.handle?.toLowerCase() === handle);
    if (textHit) return textHit;
    const blockHit = cadModel.blockInstances?.find((entry) => entry.handle?.toLowerCase() === handle);
    if (blockHit) return blockHit;
  }
  if (item.block) {
    const block = item.block.toLowerCase();
    const semanticHit = cadModel.semanticObjects?.find((entry) => (entry.blockName || entry.block || '').toLowerCase() === block);
    if (semanticHit) return semanticHit;
    const blockHit = cadModel.blockInstances?.find((entry) => (entry.block || entry.blockName || entry.name || '').toLowerCase() === block);
    if (blockHit) return blockHit;
  }
  return null;
}

function evidenceLookup(item: CadEvidenceFocusDetail, textIndex?: CadTextIndexItem[], blockIndex?: CadBlockIndexItem[], cadModel?: CadModelPayload | null): CadEvidenceLookupItem | null {
  const modelHit = cadModelLookup(item, cadModel);
  if (modelHit) return modelHit;
  if (item.handle) {
    const handle = item.handle.toLowerCase();
    const textHit = textIndex?.find((entry) => entry.handle?.toLowerCase() === handle);
    if (textHit) return textHit;
    const blockHit = blockIndex?.find((entry) => entry.handle?.toLowerCase() === handle);
    if (blockHit) return blockHit;
  }
  if (item.block) {
    const block = item.block.toLowerCase();
    const blockHit = blockIndex?.find((entry) => (entry.block || entry.blockName || entry.name || '').toLowerCase() === block);
    if (blockHit) return blockHit;
  }
  return null;
}

function entityIdFromLookup(hit: CadEvidenceLookupItem | null): string | undefined {
  if (!hit) return undefined;
  if ('entityId' in hit && typeof hit.entityId === 'string') return hit.entityId;
  if ('entityIds' in hit && Array.isArray(hit.entityIds)) return hit.entityIds.find((id) => typeof id === 'string');
  const handle = 'handle' in hit ? hit.handle : undefined;
  return handle ? `entity:${handle}` : undefined;
}

function textIdFromLookup(hit: CadEvidenceLookupItem | null): string | undefined {
  return hit && !('kind' in hit) && 'text' in hit && 'id' in hit && typeof hit.id === 'string' ? hit.id : undefined;
}

function blockInstanceIdFromLookup(hit: CadEvidenceLookupItem | null): string | undefined {
  return hit && !('kind' in hit) && ('block' in hit || 'blockName' in hit || 'attributes' in hit) && 'id' in hit && typeof hit.id === 'string' ? hit.id : undefined;
}

function semanticObjectIdFromLookup(hit: CadEvidenceLookupItem | null): string | undefined {
  return hit && 'kind' in hit && 'id' in hit && typeof hit.id === 'string' ? hit.id : undefined;
}

function handleFromLookup(hit: CadEvidenceLookupItem | null): string | undefined {
  return hit && 'handle' in hit && typeof hit.handle === 'string' ? hit.handle : undefined;
}

function evidenceBounds(item: CadEvidenceFocusDetail, textIndex?: CadTextIndexItem[], blockIndex?: CadBlockIndexItem[], cadModel?: CadModelPayload | null): CadBBox | null {
  let source: CadEvidenceFocusDetail | CadEvidenceLookupItem = item;
  if ((!Array.isArray(item.bounds) || item.bounds.length < 4) && (!Array.isArray(item.insert) || item.insert.length < 2)) {
    const hit = evidenceLookup(item, textIndex, blockIndex, cadModel);
    if (hit) source = hit;
  }

  if (Array.isArray(source.bounds) && source.bounds.length >= 4) {
    const [minX, minY, maxX, maxY] = source.bounds.map(Number);
    if ([minX, minY, maxX, maxY].every(Number.isFinite) && maxX > minX && maxY > minY) return { minX, minY, maxX, maxY };
  }
  if (Array.isArray(source.insert) && source.insert.length >= 2) {
    const [x, y] = source.insert.map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const height = Number((source as CadTextIndexItem).height || 0);
      const isBlock = !!(source as CadBlockIndexItem).block || !!(source as CadBlockIndexItem).attributes;
      const pad = isBlock ? 500 : Math.max(120, Math.min(800, height * 1.8 || 250));
      return { minX: x - pad, minY: y - pad, maxX: x + pad, maxY: y + pad };
    }
  }
  return null;
}

function mapModelBBoxToPercent(box: CadBBox, model: CadBBox, contentBox?: number[] | null, imageSize?: number[] | null) {
  const w = Math.max(1, model.maxX - model.minX);
  const h = Math.max(1, model.maxY - model.minY);
  const nx1 = clamp01((box.minX - model.minX) / w);
  const nx2 = clamp01((box.maxX - model.minX) / w);
  const ny1 = clamp01(1 - ((box.maxY - model.minY) / h));
  const ny2 = clamp01(1 - ((box.minY - model.minY) / h));

  if (contentBox && imageSize && contentBox.length >= 4 && imageSize.length >= 2) {
    const [imgW, imgH] = imageSize.map(Number);
    const [cx1, cy1, cx2, cy2] = contentBox.map(Number);
    if ([imgW, imgH, cx1, cy1, cx2, cy2].every(Number.isFinite) && imgW > 0 && imgH > 0 && cx2 > cx1 && cy2 > cy1) {
      const left = ((cx1 + nx1 * (cx2 - cx1)) / imgW) * 100;
      const right = ((cx1 + nx2 * (cx2 - cx1)) / imgW) * 100;
      const top = ((cy1 + ny1 * (cy2 - cy1)) / imgH) * 100;
      const bottom = ((cy1 + ny2 * (cy2 - cy1)) / imgH) * 100;
      return { left, top, width: Math.max(1.5, right - left), height: Math.max(1.5, bottom - top), calibrated: true };
    }
  }

  return { left: nx1 * 100, top: ny1 * 100, width: Math.max(1.5, (nx2 - nx1) * 100), height: Math.max(1.5, (ny2 - ny1) * 100), calibrated: false };
}

function tr(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, { ns: 'files', ...options });
}

function kindLabel(kind: CadViewCandidate['kind']) {
  switch (kind) {
    case 'overview': return tr('cad.kind.overview');
    case 'title-block': return tr('cad.kind.titleBlock');
    case 'table': return tr('cad.kind.table');
    case 'detail': return tr('cad.kind.detail');
    case 'layout': return tr('cad.kind.layout');
    default: return tr('cad.kind.view');
  }
}

/**
 * CAD Preview via server-side CAD → PNG rendering.
 *
 * DXF is rendered with Tower's baseline ezdxf renderer. DWG is attempted only
 * when the server has a global QCAD/ODA-style renderer configured.
 */
export function CadPreview({ filePath }: { filePath: string }) {
  useTranslation('files');
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string>('');
  const [qaStatus, setQaStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [qaError, setQaError] = useState<string>('');
  const [qaResult, setQaResult] = useState<CadQaResult | null>(null);
  const [textIndex, setTextIndex] = useState<CadTextIndexItem[]>([]);
  const [blockIndex, setBlockIndex] = useState<CadBlockIndexItem[]>([]);
  const [cadModel, setCadModel] = useState<CadModelPayload | null>(null);
  const [cadGeometryManifest, setCadGeometryManifest] = useState<CadGeometryManifestPayload | null>(null);
  const [cadGeometryStatus, setCadGeometryStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [cadGeometryError, setCadGeometryError] = useState<string>('');
  const [metadata, setMetadata] = useState<CadMetadata | null>(null);
  const [metadataError, setMetadataError] = useState<string>('');
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState<CadViewCandidate | null>(null);
  const [renderMessage, setRenderMessage] = useState<string>(() => tr('cad.render.preparing'));
  const [renderMode, setRenderMode] = useState<CadRenderMode>('dark');
  const [renderedSize, setRenderedSize] = useState<{ width: number; height: number } | null>(null);
  const [activeRenderBBox, setActiveRenderBBox] = useState<CadBBox | undefined>(undefined);
  const [isLazyUpgradePending, setIsLazyUpgradePending] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [evidenceFocus, setEvidenceFocus] = useState<CadEvidenceFocusDetail | null>(null);
  const [lastSelectionEvent, setLastSelectionEvent] = useState<{ type: string; label?: string; lookup?: string; at: number } | null>(null);
  const [currentSelection, setCurrentSelection] = useState<CadSelectionChangeDetail | null>(null);
  const [textSearch, setTextSearch] = useState('');
  const [workbenchMode, setWorkbenchMode] = useState<'preview' | 'analysis' | 'select'>('preview');
  const [geometryLayerEnabled, setGeometryLayerEnabled] = useState(() => localStorage.getItem('tower.cad.geometryViewer') === '1');
  const [artifactDetailsOpen, setArtifactDetailsOpen] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const blobUrlRef = useRef<string | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const lastSelectionSignatureRef = useRef<string>('');

  const selectedBBox = selectedCandidate?.kind === 'overview' ? undefined : selectedCandidate?.bbox;
  const selectedTitle = selectedCandidate ? selectedCandidate.label : tr('cad.fullView');
  const activeModelBBox = activeRenderBBox || selectedBBox || metadata?.overallBBox;
  const qaModelBounds = qaResult?.qa?.bounds?.modelspace;
  const contentMetrics = selectedBBox ? null : (qaResult?.qa?.visual_metrics?.content || qaResult?.qa?.visual_metrics?.full);
  const evidenceLookupHit = evidenceFocus ? evidenceLookup(evidenceFocus, textIndex, blockIndex, cadModel) : null;
  const evidenceBBox = evidenceFocus ? evidenceBounds(evidenceFocus, textIndex, blockIndex, cadModel) : null;
  const evidenceModelBBox = activeModelBBox || (Array.isArray(qaModelBounds) && qaModelBounds.length >= 4 ? { minX: qaModelBounds[0], minY: qaModelBounds[1], maxX: qaModelBounds[2], maxY: qaModelBounds[3] } : undefined);
  const evidenceOverlay = evidenceBBox && evidenceModelBBox ? mapModelBBoxToPercent(evidenceBBox, evidenceModelBBox, contentMetrics?.content_bbox_px, contentMetrics?.image_size) : null;
  const renderBackground = renderMode === 'dark' ? 'black' : 'white';
  const renderMonochrome = renderMode === 'mono';
  const viewerBgClass = renderMode === 'dark' ? 'bg-slate-950' : 'bg-slate-100';
  const topEntityTypes = useMemo(() => Object.entries(metadata?.entityTypes || {}).sort((a, b) => b[1] - a[1]).slice(0, 8), [metadata]);
  const nonEmptyLayouts = useMemo(() => (metadata?.layouts || []).filter((layout) => layout.entityCount > 0), [metadata]);
  const emptyLayouts = useMemo(() => (metadata?.layouts || []).filter((layout) => layout.entityCount === 0), [metadata]);
  const semanticObjects = useMemo(() => (cadModel?.semanticObjects || []).filter((item) => item.id || item.label || item.handle || item.blockName || item.text).slice(0, 24), [cadModel]);
  const textSearchResults = useMemo(() => {
    const query = textSearch.trim().toLocaleLowerCase();
    if (!query) return [];
    return textIndex.filter((item) => String(item.text || '').toLocaleLowerCase().includes(query)).slice(0, 20);
  }, [textIndex, textSearch]);
  const semanticKindCounts = useMemo(() => (cadModel?.semanticObjects || []).reduce<Record<string, number>>((acc, item) => {
    const key = item.kind || 'object';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {}), [cadModel]);
  const geometryCanvasEnabled = Boolean(qaResult?.artifacts?.cadGeometryManifest && cadGeometryManifest && geometryLayerEnabled);

  useEffect(() => {
    let cancelled = false;
    setMetadata(null);
    setMetadataError('');
    setMetadataLoading(true);
    setSelectedCandidate(null);

    const token = localStorage.getItem('token') || '';
    const params = new URLSearchParams({ path: filePath, token });
    fetch(`/api/files/cad-metadata?${params.toString()}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
      .then(async (res) => {
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
        return payload as CadMetadata;
      })
      .then((payload) => {
        if (cancelled) return;
        setMetadata(payload);
        const entityCount = Object.values(payload.entityTypes || {}).reduce((sum, count) => sum + count, 0);
        const isHeavyDrawing = payload.fileSize > 5 * 1024 * 1024 || entityCount > 1500;
        const initialCandidate = isHeavyDrawing
          ? (payload.candidates || []).find((candidate) => candidate.kind !== 'overview') || payload.candidates?.[0]
          : payload.candidates?.[0];
        setSelectedCandidate(initialCandidate || null);
      })
      .catch((err) => {
        if (cancelled) return;
        setMetadataError(err.message || 'CAD metadata failed');
      })
      .finally(() => {
        if (!cancelled) setMetadataLoading(false);
      });

    return () => { cancelled = true; };
  }, [filePath]);

  useEffect(() => {
    if (!metadata || !selectedCandidate) {
      setStatus('loading');
      setError('');
      setBlobUrl(null);
      setRenderedSize(null);
      setActiveRenderBBox(undefined);
      setIsLazyUpgradePending(false);
      setRenderMessage(tr('cad.render.analyzingStructure'));
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    const activeLabel = selectedBBox ? selectedTitle : tr('cad.fullDrawing');
    setStatus('loading');
    setError('');
    setBlobUrl(null);
    setRenderedSize(null);
    setActiveRenderBBox(selectedBBox);
    setIsLazyUpgradePending(false);
    setRenderMessage(tr('cad.render.preparingNamed', { name: activeLabel }));
    setZoom(1);
    setPan({ x: 0, y: 0 });

    const token = localStorage.getItem('token') || '';
    const requestPreview = async (width: number, height: number, asyncRender = false) => {
      const params = new URLSearchParams({
        path: filePath,
        width: String(width),
        height: String(height),
        background: renderBackground,
        token,
      });
      if (renderMonochrome) params.set('monochrome', 'true');
      if (selectedBBox) params.set('bbox', bboxToParam(selectedBBox));
      if (asyncRender) params.set('async', 'true');
      const res = await fetch(`/api/files/cad-preview?${params.toString()}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
      if (res.status === 202) return { status: 'rendering' as const };
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      return { status: 'ready' as const, blob: await res.blob() };
    };

    const fetchPreviewWhenReady = async (width: number, height: number, pollMs = 2000) => {
      let attempt = 0;
      const startedAt = Date.now();
      while (!cancelled) {
        const result = await requestPreview(width, height, true);
        if (result.status === 'ready') return result.blob;
        attempt += 1;
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        setRenderMessage(tr('cad.render.firstRender', { name: activeLabel, seconds: elapsed }));
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      throw new Error('CAD preview request cancelled');
    };

    const firstSize = selectedBBox ? { width: 900, height: 700 } : { width: 1200, height: 900 };
    const hiSize = selectedBBox ? { width: 1600, height: 1200 } : { width: 2400, height: 1800 };

    fetchPreviewWhenReady(firstSize.width, firstSize.height)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
        setRenderedSize(firstSize);
        setStatus('loaded');
        setRenderMessage(tr('cad.render.quickReady', { name: activeLabel }));
        return fetchPreviewWhenReady(hiSize.width, hiSize.height, 3000).then((hiBlob) => {
          if (cancelled) return;
          const hiUrl = URL.createObjectURL(hiBlob);
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = hiUrl;
          setBlobUrl(hiUrl);
          setRenderedSize(hiSize);
          setRenderMessage(tr('cad.render.detailReady', { name: activeLabel }));
        }).catch(() => undefined);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || 'Failed to render CAD preview');
        setStatus('error');
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [filePath, selectedBBox, selectedTitle, renderBackground, renderMonochrome, metadata, selectedCandidate]);

  const runQa = async () => {
    setQaStatus('running');
    setQaError('');
    setQaResult(null);
    setTextIndex([]);
    setBlockIndex([]);
    setCadModel(null);
    setCadGeometryManifest(null);
    setCadGeometryStatus('idle');
    setCadGeometryError('');
    try {
      const token = localStorage.getItem('token') || '';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch('/api/files/cad-qa', {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: filePath }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      setQaResult(payload);
      if (payload?.artifacts?.textIndex) {
        const textRes = await fetch(`/api/files/serve?path=${encodeURIComponent(payload.artifacts.textIndex)}&token=${encodeURIComponent(token)}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
        if (textRes.ok) {
          const textPayload = await textRes.json().catch(() => null) as CadTextIndexPayload | null;
          setTextIndex(Array.isArray(textPayload?.texts) ? textPayload.texts : []);
        }
      }
      if (payload?.artifacts?.blockIndex) {
        const blockRes = await fetch(`/api/files/serve?path=${encodeURIComponent(payload.artifacts.blockIndex)}&token=${encodeURIComponent(token)}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
        if (blockRes.ok) {
          const blockPayload = await blockRes.json().catch(() => null) as CadBlockIndexPayload | null;
          setBlockIndex(Array.isArray(blockPayload?.blocks) ? blockPayload.blocks : []);
        }
      }
      if (payload?.artifacts?.cadModel) {
        const modelRes = await fetch(`/api/files/serve?path=${encodeURIComponent(payload.artifacts.cadModel)}&token=${encodeURIComponent(token)}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
        if (modelRes.ok) {
          const modelPayload = await modelRes.json().catch(() => null) as CadModelPayload | null;
          setCadModel(modelPayload && typeof modelPayload === 'object' ? modelPayload : null);
        }
      }
      if (payload?.artifacts?.cadGeometryManifest) {
        setCadGeometryStatus('loading');
        const geometryRes = await fetch(`/api/files/serve?path=${encodeURIComponent(payload.artifacts.cadGeometryManifest)}&token=${encodeURIComponent(token)}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
        if (geometryRes.ok) {
          const geometryPayload = await geometryRes.json().catch(() => null) as CadGeometryManifestPayload | null;
          setCadGeometryManifest(geometryPayload && typeof geometryPayload === 'object' ? geometryPayload : null);
          setCadGeometryStatus('ready');
        } else {
          setCadGeometryStatus('error');
          setCadGeometryError(`Geometry manifest fetch failed: HTTP ${geometryRes.status}`);
        }
      }
      setQaStatus('done');
    } catch (err: any) {
      setQaError(err.message || 'CAD QA failed');
      setQaStatus('error');
    }
  };

  const token = localStorage.getItem('token') || '';
  const artifactImageUrl = (path?: string) => path
    ? `/api/files/serve?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}`
    : '';

  const clampZoom = (value: number) => Math.min(8, Math.max(0.15, value));
  const zoomLabel = `${Math.round(zoom * 100)}%`;
  const renderModeLabel = renderMode === 'dark' ? 'Dark' : renderMode === 'light' ? 'Light' : 'Mono';

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const fitView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const toggleGeometryLayer = useCallback((enabled: boolean) => {
    setGeometryLayerEnabled(enabled);
    if (enabled) {
      localStorage.setItem('tower.cad.geometryViewer', '1');
      setWorkbenchMode('select');
    } else {
      localStorage.removeItem('tower.cad.geometryViewer');
    }
  }, []);

  const requestAiForCurrentSelection = useCallback((prompt: string) => {
    const store = useAiPanelStore.getState();
    store.setOpen(true);
    window.dispatchEvent(new CustomEvent('tower:cad-workbench-action', {
      detail: {
        path: filePath,
        prompt,
        selection: currentSelection?.selection,
        cadModelArtifactPath: qaResult?.artifacts?.cadModel,
        cadGeometryManifestPath: qaResult?.artifacts?.cadGeometryManifest,
      },
    }));
  }, [currentSelection, filePath, qaResult?.artifacts?.cadGeometryManifest, qaResult?.artifacts?.cadModel]);


  const selectCandidate = useCallback((candidate: CadViewCandidate) => {
    setEvidenceFocus(null);
    setSelectedCandidate(candidate);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const focusSemanticObject = useCallback((item: CadSemanticObjectItem) => {
    setEvidenceFocus({
      label: item.label || item.text || item.blockName || item.block || item.id || 'Semantic object',
      semanticObjectId: item.id,
      entityId: item.entityIds?.[0],
      cadModelArtifactPath: qaResult?.artifacts?.cadModel,
      handle: item.handle,
      layer: item.layer,
      block: item.block || item.blockName,
      text: item.text,
      insert: item.insert,
      bounds: item.bounds,
      confidence: typeof item.confidence === 'string' ? item.confidence : item.confidence != null ? String(item.confidence) : 'inferred',
      note: item.kind,
    });
    const bounds = evidenceBounds(item as CadEvidenceFocusDetail, textIndex, blockIndex, cadModel);
    if (bounds && metadata?.candidates?.length) {
      const pointX = (bounds.minX + bounds.maxX) / 2;
      const pointY = (bounds.minY + bounds.maxY) / 2;
      const containing = metadata.candidates
        .filter((candidate) => {
          const b = candidate.bbox;
          return pointX >= b.minX && pointX <= b.maxX && pointY >= b.minY && pointY <= b.maxY;
        })
        .sort((a, b) => ((a.bbox.maxX - a.bbox.minX) * (a.bbox.maxY - a.bbox.minY)) - ((b.bbox.maxX - b.bbox.minX) * (b.bbox.maxY - b.bbox.minY)))[0];
      if (containing) setSelectedCandidate(containing);
    }
    setZoom(2.2);
    setPan({ x: 0, y: 0 });
  }, [blockIndex, cadModel, metadata, qaResult?.artifacts?.cadModel, textIndex]);

  const clearEvidenceFocus = useCallback(() => {
    setEvidenceFocus(null);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const zoomBy = useCallback((factor: number, anchor?: { x: number; y: number }) => {
    setZoom((current) => {
      const next = clampZoom(current * factor);
      if (anchor && viewportRef.current) {
        const rect = viewportRef.current.getBoundingClientRect();
        const dx = anchor.x - rect.left - rect.width / 2;
        const dy = anchor.y - rect.top - rect.height / 2;
        const ratio = next / current;
        setPan((prev) => ({
          x: dx - (dx - prev.x) * ratio,
          y: dy - (dy - prev.y) * ratio,
        }));
      }
      return next;
    });
  }, []);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (!blobUrl) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomBy(factor, { x: event.clientX, y: event.clientY });
  }, [blobUrl, zoomBy]);

  useEffect(() => {
    blobUrlRef.current = blobUrl;
  }, [blobUrl]);

  useEffect(() => {
    if (!metadata || !selectedCandidate || !blobUrl || !renderedSize || status !== 'loaded') return;
    if (zoom < 1.8) return;
    const baseBBox = selectedBBox || metadata.overallBBox;
    if (!baseBBox) return;

    const viewport = viewportRef.current;
    const rect = viewport?.getBoundingClientRect();
    const visibleW = Math.max(1, (baseBBox.maxX - baseBBox.minX) / zoom);
    const visibleH = Math.max(1, (baseBBox.maxY - baseBBox.minY) / zoom);
    const centerOffsetX = rect ? (-pan.x / Math.max(zoom, 0.01)) * ((baseBBox.maxX - baseBBox.minX) / Math.max(rect.width, 1)) : 0;
    const centerOffsetY = rect ? (pan.y / Math.max(zoom, 0.01)) * ((baseBBox.maxY - baseBBox.minY) / Math.max(rect.height, 1)) : 0;
    const cx = (baseBBox.minX + baseBBox.maxX) / 2 + centerOffsetX;
    const cy = (baseBBox.minY + baseBBox.maxY) / 2 + centerOffsetY;
    const pad = zoom >= 3 ? 0.18 : 0.28;
    const halfW = Math.min((baseBBox.maxX - baseBBox.minX) / 2, (visibleW * (1 + pad)) / 2);
    const halfH = Math.min((baseBBox.maxY - baseBBox.minY) / 2, (visibleH * (1 + pad)) / 2);
    const targetBBox: CadBBox = {
      minX: Math.max(baseBBox.minX, cx - halfW),
      minY: Math.max(baseBBox.minY, cy - halfH),
      maxX: Math.min(baseBBox.maxX, cx + halfW),
      maxY: Math.min(baseBBox.maxY, cy + halfH),
    };
    if (targetBBox.maxX <= targetBBox.minX || targetBBox.maxY <= targetBBox.minY) return;
    const currentArea = activeRenderBBox ? (activeRenderBBox.maxX - activeRenderBBox.minX) * (activeRenderBBox.maxY - activeRenderBBox.minY) : (baseBBox.maxX - baseBBox.minX) * (baseBBox.maxY - baseBBox.minY);
    const targetArea = (targetBBox.maxX - targetBBox.minX) * (targetBBox.maxY - targetBBox.minY);
    if (targetArea >= currentArea * 0.82 && renderedSize.width >= 2400) return;

    const target = zoom >= 3 ? { width: 3200, height: 2400 } : { width: 2400, height: 1800 };
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      const token = localStorage.getItem('token') || '';
      const params = new URLSearchParams({
        path: filePath,
        width: String(target.width),
        height: String(target.height),
        background: renderBackground,
        token,
        async: 'true',
      });
      if (renderMonochrome) params.set('monochrome', 'true');
      params.set('bbox', bboxToParam(targetBBox));
      const startedAt = Date.now();
      setIsLazyUpgradePending(true);
      setRenderMessage(tr('cad.render.zoomPreparing', { name: selectedTitle }));
      try {
        while (!cancelled) {
          const res = await fetch(`/api/files/cad-preview?${params.toString()}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
          if (res.status === 202) {
            const elapsed = Math.round((Date.now() - startedAt) / 1000);
            setRenderMessage(tr('cad.render.zoomPreparingElapsed', { name: selectedTitle, seconds: elapsed }));
            await new Promise((resolve) => setTimeout(resolve, 3000));
            continue;
          }
          if (!res.ok) break;
          const blob = await res.blob();
          if (cancelled) return;
          const nextUrl = URL.createObjectURL(blob);
          const previousUrl = blobUrlRef.current;
          blobUrlRef.current = nextUrl;
          setBlobUrl(nextUrl);
          setRenderedSize(target);
          setActiveRenderBBox(targetBBox);
          setZoom(1.25);
          setPan({ x: 0, y: 0 });
          setRenderMessage(tr('cad.render.zoomReady', { name: selectedTitle }));
          if (previousUrl) URL.revokeObjectURL(previousUrl);
          break;
        }
      } finally {
        if (!cancelled) setIsLazyUpgradePending(false);
      }
    }, 1000);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [activeRenderBBox, blobUrl, filePath, metadata, pan.x, pan.y, renderedSize, renderBackground, renderMonochrome, selectedBBox, selectedCandidate, selectedTitle, status, zoom]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!blobUrl) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsPanning(true);
    lastPointerRef.current = { x: event.clientX, y: event.clientY };
  }, [blobUrl]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!isPanning || !lastPointerRef.current) return;
    const last = lastPointerRef.current;
    const dx = event.clientX - last.x;
    const dy = event.clientY - last.y;
    lastPointerRef.current = { x: event.clientX, y: event.clientY };
    setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
  }, [isPanning]);

  const stopPanning = useCallback((event?: React.PointerEvent<HTMLDivElement>) => {
    if (event) {
      try { event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
    }
    setIsPanning(false);
    lastPointerRef.current = null;
  }, []);

  const focusEvidence = useCallback((item: CadEvidenceFocusDetail) => {
    setEvidenceFocus(item);
    const bounds = evidenceBounds(item, textIndex, blockIndex, cadModel);
    if (!bounds || !metadata?.candidates?.length) {
      setZoom(1.8);
      setPan({ x: 0, y: 0 });
      return;
    }

    const pointX = (bounds.minX + bounds.maxX) / 2;
    const pointY = (bounds.minY + bounds.maxY) / 2;
    const containing = metadata.candidates
      .filter((candidate) => {
        const b = candidate.bbox;
        return pointX >= b.minX && pointX <= b.maxX && pointY >= b.minY && pointY <= b.maxY;
      })
      .sort((a, b) => ((a.bbox.maxX - a.bbox.minX) * (a.bbox.maxY - a.bbox.minY)) - ((b.bbox.maxX - b.bbox.minX) * (b.bbox.maxY - b.bbox.minY)))[0];
    if (containing && containing.id !== selectedCandidate?.id) setSelectedCandidate(containing);
    setZoom(2.2);
    setPan({ x: 0, y: 0 });
  }, [metadata, selectedCandidate?.id, textIndex, blockIndex, cadModel]);

  const focusTextSearchResult = useCallback((item: CadTextIndexItem) => {
    focusEvidence({
      label: item.text || item.id || 'CAD text',
      text: item.text,
      textId: item.id,
      entityId: item.entityId,
      handle: item.handle,
      layer: item.layer,
      insert: item.insert,
      bounds: item.bounds,
      cadModelArtifactPath: qaResult?.artifacts?.cadModel,
    });
    setWorkbenchMode('analysis');
  }, [focusEvidence, qaResult?.artifacts?.cadModel]);

  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent<CadEvidenceFocusDetail>;
      if (custom.detail) focusEvidence(custom.detail);
      else setEvidenceFocus(null);
    };
    window.addEventListener('tower:cad-evidence-focus', handler as EventListener);
    return () => window.removeEventListener('tower:cad-evidence-focus', handler as EventListener);
  }, [focusEvidence]);

  const emitSelectionChange = useCallback((detail: CadSelectionChangeDetail) => {
    const signature = JSON.stringify({
      p: detail.path,
      v: detail.view?.candidateId || detail.view?.label,
      t: detail.selection.type,
      entityId: detail.selection.entityId,
      semanticObjectId: detail.selection.semanticObjectId,
      h: detail.selection.handle,
      b: detail.selection.block,
      l: detail.selection.label,
      bounds: detail.selection.bounds?.map((value) => Math.round(value)),
    });
    if (lastSelectionSignatureRef.current === signature) return;
    lastSelectionSignatureRef.current = signature;
    window.dispatchEvent(new CustomEvent('tower:cad-selection-change', { detail }));
    setCurrentSelection(detail);
    setLastSelectionEvent({
      type: detail.selection.type,
      label: detail.selection.label || detail.view?.label,
      lookup: detail.selection.lookup,
      at: Date.now(),
    });
  }, []);

  useEffect(() => {
    if (!metadata || !selectedCandidate) return;
    const lookupKind = evidenceLookupKind(evidenceLookupHit);
    const lookup = evidenceFocus ? (lookupKind === 'none' && (evidenceFocus.handle || evidenceFocus.block) && textIndex.length + blockIndex.length > 0 ? 'miss' : lookupKind) : 'none';
    emitSelectionChange({
      path: filePath,
      cadModelArtifactPath: qaResult?.artifacts?.cadModel,
      view: {
        candidateId: selectedCandidate.id,
        viewId: `view:${selectedCandidate.id}`,
        label: selectedCandidate.label,
        kind: selectedCandidate.kind,
        bbox: selectedCandidate.bbox,
      },
      viewport: { zoom, pan },
      selection: evidenceFocus ? {
        type: evidenceFocus.semanticObjectId || semanticObjectIdFromLookup(evidenceLookupHit) ? 'semantic-object' : 'evidence',
        entityId: evidenceFocus.entityId || entityIdFromLookup(evidenceLookupHit),
        textId: evidenceFocus.textId || textIdFromLookup(evidenceLookupHit),
        blockInstanceId: evidenceFocus.blockInstanceId || blockInstanceIdFromLookup(evidenceLookupHit),
        semanticObjectId: evidenceFocus.semanticObjectId || semanticObjectIdFromLookup(evidenceLookupHit),
        cadModelArtifactPath: evidenceFocus.cadModelArtifactPath || qaResult?.artifacts?.cadModel,
        handle: evidenceFocus.handle || handleFromLookup(evidenceLookupHit),
        block: evidenceFocus.block || (evidenceLookupHit && ('block' in evidenceLookupHit || 'blockName' in evidenceLookupHit) ? (evidenceLookupHit as CadBlockIndexItem | CadSemanticObjectItem).block || (evidenceLookupHit as CadBlockIndexItem | CadSemanticObjectItem).blockName : undefined),
        layer: evidenceFocus.layer || evidenceLookupHit?.layer,
        bounds: bboxToList(evidenceBBox),
        insert: evidenceFocus.insert || evidenceLookupHit?.insert,
        label: evidenceFocus.label || evidenceFocus.text || (evidenceLookupHit && 'text' in evidenceLookupHit ? evidenceLookupHit.text : undefined),
        text: evidenceFocus.text || (evidenceLookupHit && 'text' in evidenceLookupHit ? evidenceLookupHit.text : undefined),
        confidence: evidenceFocus.confidence,
        lookup,
      } : {
        type: 'view-candidate',
        cadModelArtifactPath: qaResult?.artifacts?.cadModel,
        bounds: bboxToList(selectedCandidate.bbox),
        label: selectedCandidate.label,
        lookup: 'none',
      },
    });
  }, [blockIndex.length, emitSelectionChange, evidenceBBox, evidenceFocus, evidenceLookupHit, filePath, metadata, pan, qaResult?.artifacts?.cadModel, selectedCandidate, textIndex.length, zoom]);

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden bg-slate-950 text-gray-800">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <span>CAD Workbench</span>
            <span className="rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">beta</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-700">{selectedTitle}</span>
            {geometryLayerEnabled && <span className="rounded-full border border-cyan-300 bg-cyan-50 px-2 py-0.5 text-[10px] font-bold text-cyan-700">{tr('cad.objectSelectionLayer')}</span>}
          </div>
          <div className="truncate text-xs text-slate-500" title={filePath}>{filePath.split('/').pop() || filePath}</div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <div className="flex items-center overflow-hidden rounded-xl border border-slate-300 bg-slate-50 text-xs font-semibold text-slate-700 shadow-sm">
            {([
              ['preview', tr('cad.tabs.original')],
              ['analysis', tr('cad.tabs.analysis')],
              ['select', tr('cad.tabs.selectBeta')],
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setWorkbenchMode(mode)}
                className={`px-3 py-1.5 ${workbenchMode === mode ? 'bg-slate-900 text-white' : 'hover:bg-white'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <label className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold shadow-sm ${geometryLayerEnabled ? 'border-cyan-300 bg-cyan-50 text-cyan-800' : 'border-slate-300 bg-white text-slate-600'}`} title={tr('cad.analysisLayerTitle')}>
            <input type="checkbox" className="h-3.5 w-3.5" checked={geometryLayerEnabled} onChange={(event) => toggleGeometryLayer(event.target.checked)} disabled={!qaResult?.artifacts?.cadGeometryManifest} />
            {tr('cad.analysisLayerBeta')}
          </label>
          <div className="flex items-center overflow-hidden rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700 shadow-sm">
            {(['dark', 'light', 'mono'] as CadRenderMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setRenderMode(mode)}
                className={`px-2.5 py-1.5 ${renderMode === mode ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}
                title={`${mode} CAD render mode`}
              >
                {mode === 'dark' ? 'Dark' : mode === 'light' ? 'Light' : 'Mono'}
              </button>
            ))}
          </div>
          <div className="flex items-center overflow-hidden rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700 shadow-sm">
            <button type="button" onClick={() => zoomBy(1 / 1.2)} disabled={!blobUrl} className="px-2.5 py-1.5 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40" title="Zoom out">−</button>
            <span className="min-w-14 border-x border-slate-200 px-2 py-1.5 text-center tabular-nums text-slate-900">{zoomLabel}</span>
            <button type="button" onClick={() => zoomBy(1.2)} disabled={!blobUrl} className="px-2.5 py-1.5 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40" title="Zoom in">+</button>
            <button type="button" onClick={fitView} disabled={!blobUrl} className="border-l border-slate-200 px-2.5 py-1.5 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40" title="Fit to view">Fit</button>
            <button type="button" onClick={resetView} disabled={!blobUrl} className="border-l border-slate-200 px-2.5 py-1.5 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40" title="100%">100%</button>
          </div>
          <button
            type="button"
            onClick={runQa}
            disabled={qaStatus === 'running'}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {qaStatus === 'running' ? tr('cad.context.preparing') : tr('cad.context.prepare')}
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px] overflow-hidden bg-slate-950">
        <div className={`relative min-h-0 overflow-hidden ${viewerBgClass} p-3`}>
          {status === 'loading' && (
            <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 text-base text-slate-300">
              <svg className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {renderMessage}
            </div>
          )}
          {status === 'error' && (
            <div className="absolute inset-0 flex items-center justify-center p-4">
              <div className="max-w-md rounded-lg border border-red-200 bg-red-50 p-4 text-base text-red-700">
                <div className="mb-1 font-medium">CAD preview failed</div>
                <div className="break-words">{error}</div>
              </div>
            </div>
          )}
          {blobUrl && (
            <div className={`absolute inset-3 flex flex-col overflow-hidden rounded-xl border border-slate-700 ${viewerBgClass} shadow-sm`}>
              <div
                ref={viewportRef}
                className={`relative min-h-0 flex-1 select-none overflow-hidden ${viewerBgClass} ${isPanning ? 'cursor-grabbing' : 'cursor-grab'}`}
                onWheel={handleWheel}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={stopPanning}
                onPointerCancel={stopPanning}
                onDoubleClick={resetView}
                title="Wheel to zoom, drag to pan, double-click to reset"
              >
                <div className="absolute inset-5 flex items-center justify-center">
                  <div
                    className="relative h-full max-h-full w-full max-w-full will-change-transform"
                    style={{
                      transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                      transformOrigin: 'center center',
                    }}
                  >
                    <img
                      src={blobUrl}
                      alt={filePath.split('/').pop() || 'CAD preview'}
                      draggable={false}
                      className="block h-full max-h-full w-full max-w-full object-contain [image-rendering:auto]"
                    />
                    {geometryCanvasEnabled && qaResult?.artifacts?.cadGeometryManifest && (
                      <CadGeometryCanvasLayer
                        manifestPath={qaResult.artifacts.cadGeometryManifest}
                        filePath={filePath}
                        token={token}
                        enabled={geometryCanvasEnabled}
                        onSelectionChange={(detail) => emitSelectionChange(detail)}
                      />
                    )}
                    {evidenceFocus && evidenceOverlay && (
                      <div
                        className="pointer-events-none absolute rounded-md border-2 border-cyan-300 bg-cyan-300/15 shadow-[0_0_24px_rgba(103,232,249,0.75)]"
                        style={{
                          left: `${evidenceOverlay.left}%`,
                          top: `${evidenceOverlay.top}%`,
                          width: `${evidenceOverlay.width}%`,
                          height: `${evidenceOverlay.height}%`,
                        }}
                      >
                        <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-t-md border border-cyan-300/70 bg-slate-950/90 px-2 py-1 text-[11px] text-cyan-100 shadow-lg">
                          {evidenceFocus.label || evidenceFocus.text || 'CAD evidence'}
                        </div>
                      </div>
                    )}
                    {evidenceFocus && !evidenceOverlay && (
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                        <div className="max-w-[80%] rounded-lg border border-cyan-300/70 bg-slate-950/85 px-3 py-2 text-center text-xs text-cyan-100 shadow-lg">
                          <div className="font-semibold">{evidenceFocus.label || evidenceFocus.text || 'CAD evidence'}</div>
                          <div className="mt-0.5 text-[11px] text-cyan-100/75">
                            {[evidenceFocus.handle ? `handle ${evidenceFocus.handle}` : null, evidenceFocus.layer ? `layer ${evidenceFocus.layer}` : null, evidenceFocus.insert ? `insert ${evidenceFocus.insert.slice(0, 2).join(', ')}` : null].filter(Boolean).join(' · ') || tr('cad.evidenceLocation')}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="rounded-full bg-white px-2 py-0.5 font-semibold text-slate-700 ring-1 ring-slate-200">{zoomLabel}</span>
                  <span className="truncate">{tr('cad.viewerStatus', { mode: renderModeLabel, preview: activeRenderBBox ? 'zoom-region preview' : selectedBBox ? 'region preview' : 'overview preview', size: renderedSize ? `${renderedSize.width}×${renderedSize.height}` : tr('cad.render.waiting'), upgrading: isLazyUpgradePending ? tr('cad.render.upgradingSuffix') : '' })}</span>
                </div>
                <div className="shrink-0 font-mono tabular-nums text-slate-400">pan {Math.round(pan.x)}, {Math.round(pan.y)}</div>
              </div>
            </div>
          )}
        </div>

        <aside className="min-h-0 overflow-auto border-l border-slate-800 bg-slate-900 p-3 text-xs text-slate-200">
          <div className="space-y-3">
            <section className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="font-semibold text-white">{tr('cad.structure')}</div>
                {metadataLoading && <span className="text-[11px] text-slate-400">{tr('cad.analyzing')}</span>}
              </div>
              {metadataError ? (
                <div className="rounded border border-red-800 bg-red-950/50 p-2 text-red-200">{metadataError}</div>
              ) : metadata ? (
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div className="rounded bg-slate-900 p-2"><div className="text-slate-400">{tr('cad.file')}</div><div className="font-semibold text-slate-100">{fileSizeLabel(metadata.fileSize)}</div></div>
                  <div className="rounded bg-slate-900 p-2"><div className="text-slate-400">Entities</div><div className="font-semibold text-slate-100">{formatNumber(Object.values(metadata.entityTypes).reduce((a, b) => a + b, 0))}</div></div>
                  <div className="rounded bg-slate-900 p-2"><div className="text-slate-400">Layouts</div><div className="font-semibold text-slate-100">{nonEmptyLayouts.length} active / {emptyLayouts.length} empty</div></div>
                  <div className="rounded bg-slate-900 p-2"><div className="text-slate-400">BBox</div><div className="font-semibold text-slate-100">{bboxSizeLabel(metadata.overallBBox)}</div></div>
                </div>
              ) : <div className="text-slate-400">{tr('cad.metadataWaiting')}</div>}
              {metadata && emptyLayouts.length > 0 && (
                <div className="mt-2 rounded border border-amber-700/60 bg-amber-950/30 p-2 text-[11px] text-amber-100">
                  {emptyLayouts.map((layout) => layout.name).join(', ')} {tr('cad.emptyLayouts')}
                </div>
              )}
              {lastSelectionEvent && (
                <div className="mt-2 rounded border border-slate-700 bg-slate-900/80 p-2 text-[11px] text-slate-300">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-100">selection event</span>
                    <span className="text-slate-500">{new Date(lastSelectionEvent.at).toLocaleTimeString()}</span>
                  </div>
                  <div className="mt-1 truncate" title={lastSelectionEvent.label}>{lastSelectionEvent.type}: {lastSelectionEvent.label || 'selection'}</div>
                  {lastSelectionEvent.lookup && lastSelectionEvent.lookup !== 'none' && <div className="mt-1 text-slate-400">lookup {lastSelectionEvent.lookup}</div>}
                </div>
              )}
              {evidenceFocus && (
                <div className="mt-2 rounded border border-cyan-700/70 bg-cyan-950/40 p-2 text-[11px] text-cyan-100">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold">{tr('cad.evidenceFocus')}</div>
                    <button
                      type="button"
                      onClick={clearEvidenceFocus}
                      className="rounded border border-cyan-600/60 px-1.5 py-0.5 text-[10px] text-cyan-100 hover:bg-cyan-900/60"
                    >
                      clear
                    </button>
                  </div>
                  <div className="mt-1">{evidenceFocus.label || evidenceFocus.text || 'CAD evidence'}</div>
                  <div className="mt-1 text-cyan-100/70">
                    {[evidenceFocus.handle ? `handle ${evidenceFocus.handle}` : null, evidenceFocus.layer ? `layer ${evidenceFocus.layer}` : null, evidenceFocus.block ? `block ${evidenceFocus.block}` : null, evidenceFocus.confidence ? `confidence ${evidenceFocus.confidence}` : null].filter(Boolean).join(' · ')}
                  </div>
                  {evidenceLookupHit && (
                    <div className="mt-1 text-cyan-100/60">
                      lookup: {evidenceLookupKind(evidenceLookupHit)}
                      {evidenceLookupHit.layer ? ` · layer ${evidenceLookupHit.layer}` : ''}
                    </div>
                  )}
                  {evidenceFocus.handle && !evidenceLookupHit && textIndex.length + blockIndex.length + semanticObjects.length > 0 && (
                    <div className="mt-1 text-amber-100/80">handle lookup miss</div>
                  )}
                </div>
              )}
            </section>

            <section className="rounded-xl border border-cyan-700/60 bg-cyan-950/30 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="font-semibold text-cyan-50">{tr('cad.currentContext')}</div>
                <span className="rounded-full bg-cyan-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-100">selection</span>
              </div>
              {evidenceFocus || lastSelectionEvent ? (
                <div className="space-y-2 text-[11px] text-cyan-50">
                  <div className="rounded bg-slate-950/50 p-2">
                    <div className="font-semibold">{evidenceFocus?.label || evidenceFocus?.text || currentSelection?.selection.label || lastSelectionEvent?.label || selectedTitle}</div>
                    <div className="mt-1 text-cyan-100/70">
                      {[currentSelection?.selection.primitiveId ? `primitive ${currentSelection.selection.primitiveId}` : null, evidenceFocus?.semanticObjectId || currentSelection?.selection.semanticObjectId ? `semantic ${evidenceFocus?.semanticObjectId || currentSelection?.selection.semanticObjectId}` : null, evidenceFocus?.entityId || currentSelection?.selection.entityId ? `entity ${evidenceFocus?.entityId || currentSelection?.selection.entityId}` : null, evidenceFocus?.handle || currentSelection?.selection.handle ? `handle ${evidenceFocus?.handle || currentSelection?.selection.handle}` : null, currentSelection?.selection.layer ? `layer ${currentSelection.selection.layer}` : null, lastSelectionEvent?.lookup ? `lookup ${lastSelectionEvent.lookup}` : null].filter(Boolean).join(' · ') || tr('cad.currentViewSent')}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-1.5">
                    <button type="button" onClick={() => requestAiForCurrentSelection('선택한 CAD 객체/영역을 설명해줘')} className="rounded border border-cyan-600/60 bg-cyan-900/50 px-2 py-1.5 text-left font-semibold text-cyan-50 hover:bg-cyan-800/70">{tr('cad.actions.explain')}</button>
                    <button type="button" onClick={() => requestAiForCurrentSelection('선택한 CAD 객체와 관련된 치수, 주석, 주변 객체를 찾아줘')} className="rounded border border-cyan-600/60 bg-cyan-900/50 px-2 py-1.5 text-left font-semibold text-cyan-50 hover:bg-cyan-800/70">{tr('cad.actions.findRelated')}</button>
                    <button type="button" onClick={() => requestAiForCurrentSelection('선택한 CAD 객체를 검토 이슈 또는 수정 요청 초안으로 정리해줘')} className="rounded border border-cyan-600/60 bg-cyan-900/50 px-2 py-1.5 text-left font-semibold text-cyan-50 hover:bg-cyan-800/70">{tr('cad.actions.createRequest')}</button>
                  </div>
                </div>
              ) : (
                <div className="rounded bg-slate-950/50 p-2 text-[11px] text-cyan-100/75">{tr('cad.contextHint')}</div>
              )}
            </section>

            {(workbenchMode === 'analysis' || workbenchMode === 'select') && qaStatus === 'done' && (
              <section className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="font-semibold text-white">{tr('cad.textSearch')}</div>
                  <span className="text-[10px] text-slate-500">{formatNumber(textIndex.length)} indexed</span>
                </div>
                <input
                  value={textSearch}
                  onChange={(event) => setTextSearch(event.target.value)}
                  placeholder={tr('cad.textSearchPlaceholder')}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2 text-[11px] text-slate-100 outline-none placeholder:text-slate-500 focus:border-cyan-500"
                />
                {textSearch.trim() && (
                  <div className="mt-2 max-h-48 space-y-1 overflow-auto pr-1">
                    {textSearchResults.map((item, idx) => (
                      <button
                        key={item.id || `${item.handle || 'text'}-${idx}`}
                        type="button"
                        onClick={() => focusTextSearchResult(item)}
                        className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-left hover:border-cyan-600 hover:bg-slate-800"
                      >
                        <div className="truncate font-semibold text-slate-100" title={item.text}>{item.text || tr('cad.emptyText')}</div>
                        <div className="mt-0.5 truncate text-[10px] text-slate-500">{[item.layer ? `layer ${item.layer}` : null, item.handle ? `handle ${item.handle}` : null].filter(Boolean).join(' · ')}</div>
                      </button>
                    ))}
                    {textSearchResults.length === 0 && <div className="rounded bg-slate-900 p-2 text-[11px] text-slate-500">{tr('cad.noMatchingText')}</div>}
                  </div>
                )}
              </section>
            )}

            {(workbenchMode === 'preview' || workbenchMode === 'analysis') && <section className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
              <div className="mb-2 font-semibold text-white">View candidates</div>
              <div className="space-y-1.5">
                {(metadata?.candidates || []).map((candidate) => {
                  const active = selectedCandidate?.id === candidate.id;
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      onClick={() => selectCandidate(candidate)}
                      className={`w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${active ? 'border-cyan-400 bg-cyan-950/60 text-cyan-50' : 'border-slate-700 bg-slate-900 text-slate-200 hover:border-slate-500 hover:bg-slate-800'}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">{candidate.label}</span>
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">{kindLabel(candidate.kind)}</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-400">
                        <span>{bboxSizeLabel(candidate.bbox)}</span>
                        <span>{formatNumber(candidate.entityCount)} ent</span>
                      </div>
                    </button>
                  );
                })}
                {!metadataLoading && (metadata?.candidates || []).length === 0 && <div className="text-slate-400">{tr('cad.noCandidateRegions')}</div>}
              </div>
            </section>}

            {(workbenchMode === 'analysis' || workbenchMode === 'select') && cadGeometryManifest?.counts && (
              <section className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="font-semibold text-white">{tr('cad.analysisReadiness')}</div>
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${cadGeometryStatus === 'ready' ? 'bg-emerald-500/15 text-emerald-100' : 'bg-slate-800 text-slate-300'}`}>{cadGeometryStatus}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  <div className="rounded bg-slate-900 p-2"><div className="text-slate-400">{tr('cad.text')}</div><div className="font-semibold text-slate-100">{formatNumber(textIndex.length)}</div></div>
                  <div className="rounded bg-slate-900 p-2"><div className="text-slate-400">{tr('cad.objectCandidates')}</div><div className="font-semibold text-slate-100">{formatNumber(cadModel?.semanticObjects?.length || 0)}</div></div>
                  <div className="rounded bg-slate-900 p-2"><div className="text-slate-400">{tr('cad.clickablePrimitives')}</div><div className="font-semibold text-slate-100">{formatNumber(cadGeometryManifest.counts.primitives || 0)}</div></div>
                </div>
                {Object.keys(semanticKindCounts).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {Object.entries(semanticKindCounts).map(([kind, count]) => <span key={kind} className="rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-[10px] text-slate-300">{kind} {formatNumber(count)}</span>)}
                  </div>
                )}
                <div className="mt-2 rounded border border-amber-700/60 bg-amber-950/30 p-2 text-[11px] text-amber-100">{tr('cad.betaWarning')}</div>
              </section>
            )}

            {semanticObjects.length > 0 && (
              <section className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="font-semibold text-white">Semantic objects</div>
                  <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-100">cad-model</span>
                </div>
                <div className="max-h-64 space-y-1.5 overflow-auto pr-1">
                  {semanticObjects.map((item, idx) => {
                    const active = !!evidenceFocus?.semanticObjectId && evidenceFocus.semanticObjectId === item.id;
                    const label = item.label || item.text || item.blockName || item.block || item.id || `Object ${idx + 1}`;
                    return (
                      <button
                        key={item.id || `${item.kind || 'semantic'}-${idx}`}
                        type="button"
                        onClick={() => focusSemanticObject(item)}
                        className={`w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${active ? 'border-cyan-400 bg-cyan-950/60 text-cyan-50' : 'border-slate-700 bg-slate-900 text-slate-200 hover:border-slate-500 hover:bg-slate-800'}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-semibold" title={label}>{label}</span>
                          {item.kind && <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">{item.kind}</span>}
                        </div>
                        <div className="mt-1 flex min-w-0 items-center justify-between gap-2 text-[11px] text-slate-400">
                          <span className="truncate" title={item.id}>{item.id || item.handle || 'semantic object'}</span>
                          {item.entityIds?.[0] && <span className="shrink-0 font-mono">{item.entityIds[0]}</span>}
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2 text-[11px] text-slate-500">{tr('cad.selectionHint')}</div>
              </section>
            )}

            {metadata && (
              <section className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
                <div className="mb-2 font-semibold text-white">Layers / entity types</div>
                <div className="mb-3 max-h-32 space-y-1 overflow-auto pr-1">
                  {metadata.layers.slice(0, 12).map((layer) => (
                    <div key={layer.name} className="flex items-center justify-between gap-2 rounded bg-slate-900 px-2 py-1 text-[11px]">
                      <span className="truncate" title={layer.name}>{layer.name}</span>
                      <span className="tabular-nums text-slate-400">{formatNumber(layer.entityCount)}</span>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {topEntityTypes.map(([type, count]) => (
                    <span key={type} className="rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-[10px] text-slate-300">{type} {formatNumber(count)}</span>
                  ))}
                </div>
              </section>
            )}
          </div>
        </aside>
      </div>

      {(qaStatus === 'done' || qaStatus === 'error') && (
        <div className="max-h-72 overflow-auto border-t border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
          {qaStatus === 'error' ? (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-red-700">
              <div className="font-semibold">CAD QA failed</div>
              <div className="mt-1 break-words">{qaError}</div>
            </div>
          ) : qaResult ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-gray-900">{tr('cad.contextStatus', { status: qaResult.status === 'passed' ? tr('cad.ready') : (qaResult.status || 'done') })}</span>
                {(qaResult.warnings || []).length > 0 && <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">{qaResult.warnings?.length} warning(s)</span>}
              </div>
              {(qaResult.warnings || []).length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-amber-800">
                  {qaResult.warnings?.map((warning, idx) => <li key={idx}>{warning}</li>)}
                </ul>
              )}
              {qaResult.artifacts && (
                <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
                  <div>
                    <div className="mb-1 font-medium text-gray-900">Content-fit preview</div>
                    <img src={artifactImageUrl(qaResult.artifacts.previewContent)} alt="CAD content-fit QA preview" className="max-h-40 rounded border border-gray-200 bg-white object-contain" />
                  </div>
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                      <div className="rounded-lg border border-gray-200 bg-white p-2"><div className="text-[10px] text-gray-500">{tr('cad.text')}</div><div className="font-semibold text-gray-900">{formatNumber(textIndex.length)}</div></div>
                      <div className="rounded-lg border border-gray-200 bg-white p-2"><div className="text-[10px] text-gray-500">{tr('cad.blocks')}</div><div className="font-semibold text-gray-900">{formatNumber(blockIndex.length)}</div></div>
                      <div className="rounded-lg border border-gray-200 bg-white p-2"><div className="text-[10px] text-gray-500">{tr('cad.aiObjects')}</div><div className="font-semibold text-gray-900">{formatNumber(cadModel?.semanticObjects?.length || 0)}</div></div>
                      <div className="rounded-lg border border-gray-200 bg-white p-2"><div className="text-[10px] text-gray-500">{tr('cad.clickablePrimitives')}</div><div className="font-semibold text-gray-900">{formatNumber(cadGeometryManifest?.counts?.primitives || 0)}</div></div>
                    </div>
                    {cadGeometryStatus !== 'idle' && (
                      <div className="rounded border border-cyan-100 bg-cyan-50 p-2 text-[11px] text-cyan-900">
                        <div className="font-semibold">{tr('cad.layerReadiness', { status: cadGeometryStatus, display: geometryCanvasEnabled ? tr('cad.showingSuffix') : tr('cad.toggleSuffix') })}</div>
                        {cadGeometryManifest?.counts && <div className="mt-1">tiles {formatNumber(cadGeometryManifest.counts.tiles || 0)} · overview {formatNumber(cadGeometryManifest.counts.overviewPrimitives || 0)}</div>}
                        {cadGeometryError && <div className="mt-1 text-red-700">{cadGeometryError}</div>}
                      </div>
                    )}
                    <button type="button" onClick={() => setArtifactDetailsOpen((value) => !value)} className="text-[11px] font-semibold text-gray-600 underline decoration-dotted underline-offset-2 hover:text-gray-900">
                      {artifactDetailsOpen ? tr('cad.hideArtifacts') : tr('cad.showArtifacts')}
                    </button>
                    {artifactDetailsOpen && (
                      <div className="space-y-1 break-all rounded border border-gray-200 bg-white p-2 font-mono text-[11px] text-gray-600">
                        <div>{qaResult.artifacts.dir}</div>
                        <div>{qaResult.artifacts.qa}</div>
                        {qaResult.artifacts.aiBrief && <div>{qaResult.artifacts.aiBrief}</div>}
                        {qaResult.artifacts.textIndex && <div>{qaResult.artifacts.textIndex}</div>}
                        {qaResult.artifacts.layerSummary && <div>{qaResult.artifacts.layerSummary}</div>}
                        {qaResult.artifacts.blockIndex && <div>{qaResult.artifacts.blockIndex}</div>}
                        {qaResult.artifacts.candidateReport && <div>{qaResult.artifacts.candidateReport}</div>}
                        {qaResult.artifacts.cadModel && <div>{qaResult.artifacts.cadModel}</div>}
                        {qaResult.artifacts.cadGeometryManifest && <div>{qaResult.artifacts.cadGeometryManifest}</div>}
                        {qaResult.artifacts.cadGeometryOverview && <div>{qaResult.artifacts.cadGeometryOverview}</div>}
                        {qaResult.artifacts.cadGeometryUnsupportedSummary && <div>{qaResult.artifacts.cadGeometryUnsupportedSummary}</div>}
                        {qaResult.artifacts.candidateReportMd && <div>{qaResult.artifacts.candidateReportMd}</div>}
                        {qaResult.artifacts.rfqIntake && <div>{qaResult.artifacts.rfqIntake}</div>}
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="text-[11px] text-gray-500">{tr('cad.artifactDescription')}</div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
