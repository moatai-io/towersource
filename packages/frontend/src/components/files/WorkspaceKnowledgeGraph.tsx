/**
 * Owns: interactive Local/Global document graph for ProjectHome.
 * Uses MIT force-graph; data and access control remain Tower-owned.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ForceGraph from 'force-graph';
import type { ForceGraphGeneric } from 'force-graph';
import { ProjectActivityGraph } from './ProjectActivityGraph';

interface GraphNode {
  id: string;
  path: string;
  label: string;
  kind: string;
  inferredType: string;
  score: number;
  degree: number;
  unresolved?: boolean;
  x?: number;
  y?: number;
}

interface GraphEdge {
  id: string;
  source: string | GraphNode;
  target: string | GraphNode;
  kind: 'markdown-link' | 'wiki-link' | 'source' | 'lineage';
  weight: number;
  inferred: false;
}

interface GraphResponse {
  projectRoot: string;
  truncated: boolean;
  summary: {
    nodes: number;
    edges: number;
    connectedNodes: number;
    orphanNodes: number;
    unresolvedNodes: number;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
}

type GraphMode = 'global' | 'local';
type ForceGraphApi = ForceGraphGeneric<ForceGraph<GraphNode, GraphEdge>, GraphNode, GraphEdge>;

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function endpointId(value: string | GraphNode): string {
  return typeof value === 'string' ? value : value.id;
}

function nodeColor(node: GraphNode, selectedId: string | null, neighborIds: Set<string>): string {
  if (node.unresolved) return selectedId === node.id ? '#f59e0b' : '#64748b';
  if (selectedId && node.id === selectedId) return '#fbbf24';
  if (selectedId && neighborIds.has(node.id)) return '#60a5fa';
  switch (node.inferredType) {
    case 'decision': return '#f59e0b';
    case 'research': return '#a78bfa';
    case 'record': return '#38bdf8';
    case 'final': return '#34d399';
    case 'source': return '#94a3b8';
    case 'guide': return '#fb7185';
    default: return '#cbd5e1';
  }
}

function neighborhood(data: GraphResponse, centerId: string, depth: number): Set<string> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of data.edges) {
    const source = endpointId(edge.source);
    const target = endpointId(edge.target);
    if (!adjacency.has(source)) adjacency.set(source, new Set());
    if (!adjacency.has(target)) adjacency.set(target, new Set());
    adjacency.get(source)!.add(target);
    adjacency.get(target)!.add(source);
  }
  const visited = new Set([centerId]);
  let frontier = new Set([centerId]);
  for (let hop = 0; hop < depth; hop += 1) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) || []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.add(neighbor);
        }
      }
    }
    frontier = next;
  }
  return visited;
}

export function WorkspaceKnowledgeGraph({
  projectId,
  rootPath,
  onOpenFile,
  onOpenSession,
}: {
  projectId: string;
  rootPath: string;
  onOpenFile: (absolutePath: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useTranslation('files');
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphApi | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  const focusIdsRef = useRef<Set<string>>(new Set());
  const [data, setData] = useState<GraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<GraphMode>('global');
  const [depth, setDepth] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hideOrphans, setHideOrphans] = useState(true);
  const [showUnresolved, setShowUnresolved] = useState(true);
  const [layoutSettled, setLayoutSettled] = useState(false);
  const [graphKind, setGraphKind] = useState<'documents' | 'activity'>('documents');

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ path: rootPath, maxFiles: '1500', maxDepth: '8', includeUnresolved: 'true' });
    setLoading(true);
    setError('');
    void fetch(`/api/files/knowledge-graph?${params.toString()}`, { headers: authHeaders() })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || t('knowledgeGraph.loadFailedStatus', { status: res.status }));
        return body as GraphResponse;
      })
      .then((body) => {
        if (cancelled) return;
        setData(body);
        const firstConnected = body.nodes.find((node) => node.degree > 0 && !node.unresolved);
        setSelectedId(firstConnected?.id || body.nodes[0]?.id || null);
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : t('knowledgeGraph.loadFailed')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [rootPath, t]);

  const selectedNode = useMemo(() => data?.nodes.find((node) => node.id === selectedId) || null, [data, selectedId]);
  const selectedConnections = useMemo(() => {
    if (!data || !selectedId) return { incoming: 0, outgoing: 0 };
    let incoming = 0;
    let outgoing = 0;
    for (const edge of data.edges) {
      if (endpointId(edge.source) === selectedId) outgoing += 1;
      if (endpointId(edge.target) === selectedId) incoming += 1;
    }
    return { incoming, outgoing };
  }, [data, selectedId]);
  const selectedKindLabel = t(`knowledgeGraph.nodeKind.${selectedNode?.unresolved ? 'unresolved' : selectedNode?.inferredType || 'unknown'}`);
  const graphData = useMemo(() => {
    if (!data) return { nodes: [] as GraphNode[], links: [] as GraphEdge[] };
    const q = query.trim().toLocaleLowerCase();
    const localIds = mode === 'local' && selectedId ? neighborhood(data, selectedId, depth) : null;
    const nodes = data.nodes.filter((node) => {
      if (!showUnresolved && node.unresolved) return false;
      if (hideOrphans && node.degree === 0) return false;
      if (localIds && !localIds.has(node.id)) return false;
      if (q && !node.label.toLocaleLowerCase().includes(q) && !node.path.toLocaleLowerCase().includes(q)) return false;
      return true;
    }).map((node) => ({ ...node }));
    const ids = new Set(nodes.map((node) => node.id));
    const links = data.edges.filter((edge) => ids.has(endpointId(edge.source)) && ids.has(endpointId(edge.target))).map((edge) => ({ ...edge }));
    return { nodes, links };
  }, [data, depth, hideOrphans, mode, query, selectedId, showUnresolved]);

  const focusIds = useMemo(() => {
    const centerId = hoveredId || selectedId;
    if (!data || !centerId) return new Set<string>();
    return neighborhood(data, centerId, 1);
  }, [data, hoveredId, selectedId]);
  selectedIdRef.current = selectedId;
  hoveredIdRef.current = hoveredId;
  focusIdsRef.current = focusIds;

  useEffect(() => {
    const container = containerRef.current;
    if (graphKind !== 'documents' || loading || error || !data || !container || graphRef.current) return;
    const graph = new ForceGraph<GraphNode, GraphEdge>(container)
      .backgroundColor('rgba(0,0,0,0)')
      .nodeId('id')
      .warmupTicks(60)
      .cooldownTicks(120)
      .cooldownTime(1800)
      .d3AlphaDecay(0.035)
      .d3VelocityDecay(0.42)
      .autoPauseRedraw(false)
      .nodeLabel(() => '')
      .nodeVal((node) => Math.max(2.5, Math.min(11, 2.5 + Math.sqrt(node.degree + 1) * 1.8)))
      .nodeColor((node) => nodeColor(node, selectedIdRef.current, focusIdsRef.current))
      .nodeCanvasObjectMode(() => 'after')
      .nodeCanvasObject((node, ctx, globalScale) => {
        const isPrimary = node.id === selectedIdRef.current || node.id === hoveredIdRef.current;
        const isNeighbor = focusIdsRef.current.has(node.id);
        if (!isPrimary && !isNeighbor && globalScale < 2.6) return;
        const radius = Math.max(2.5, Math.min(11, 2.5 + Math.sqrt(node.degree + 1) * 1.8));
        const fontSize = Math.max((isPrimary ? 13 : 10) / globalScale, 2.8);
        ctx.font = `${isPrimary ? '600 ' : ''}${fontSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = document.documentElement.dataset.theme === 'light' ? 'rgba(15,23,42,0.92)' : 'rgba(241,245,249,0.92)';
        ctx.fillText(node.label.slice(0, 42), node.x || 0, (node.y || 0) - radius - 3 / globalScale);
      })
      .linkColor((edge) => edge.kind === 'source' || edge.kind === 'lineage' ? 'rgba(96,165,250,0.65)' : 'rgba(148,163,184,0.34)')
      .linkWidth((edge) => edge.weight)
      .enableNodeDrag(true)
      .enableZoomInteraction(true)
      .onNodeHover((node) => setHoveredId(node?.id || null))
      .onNodeClick((node) => {
        setSelectedId(node.id);
        if (Number.isFinite(node.x) && Number.isFinite(node.y)) {
          graph.centerAt(node.x, node.y, 350);
          graph.zoom(2.5, 350);
        }
      })
      .onEngineStop(() => setLayoutSettled(true));
    const charge = graph.d3Force('charge') as { strength(value: number): unknown; distanceMax(value: number): unknown } | undefined;
    charge?.strength(-160);
    charge?.distanceMax(480);
    graph.d3Force('link')?.distance(70);
    const center = graph.d3Force('center') as { strength(value: number): unknown } | undefined;
    center?.strength(0.03);
    graphRef.current = graph;
    const observer = new ResizeObserver(([entry]) => graph.width(entry.contentRect.width).height(entry.contentRect.height));
    observer.observe(container);
    return () => {
      observer.disconnect();
      graph.pauseAnimation();
      container.replaceChildren();
      graphRef.current = null;
    };
  }, [data, error, graphKind, loading]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    setLayoutSettled(false);
    graph.graphData(graphData);
    window.setTimeout(() => graph.zoomToFit(400, 50), 180);
  }, [graphData]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    graph.nodeColor((node) => {
      if (hoveredId && !focusIds.has(node.id)) return 'rgba(100,116,139,0.2)';
      return nodeColor(node, selectedId, focusIds);
    });
    graph.linkColor((edge) => {
      const source = endpointId(edge.source);
      const target = endpointId(edge.target);
      if (hoveredId && source !== hoveredId && target !== hoveredId) return 'rgba(100,116,139,0.08)';
      return edge.kind === 'source' || edge.kind === 'lineage' ? 'rgba(96,165,250,0.7)' : 'rgba(148,163,184,0.38)';
    });
    // force-graph 1.x has no public refresh() API. autoPauseRedraw(false)
    // keeps the canvas repainting, so replacing accessors is sufficient and
    // does not restart the physics simulation on hover.
  }, [focusIds, hoveredId, selectedId]);

  const startConnectedDocsSession = (mode: 'create' | 'upgrade') => {
    const creating = mode === 'create';
    const prompt = `/wiki-compile\n\n이 프로젝트의 연결 문서를 ${creating ? '처음 만들어줘' : '점검하고 업그레이드해줘'}. 기존 파일은 사용자 확인 없이 이동하지 말고, 프로젝트 자료를 근거로 문서 간 링크와 sources 관계가 그래프에 드러나도록 작업해줘.`;
    window.dispatchEvent(new CustomEvent('tower-start-prompt-session', {
      detail: {
        projectId,
        prompt,
        sessionName: creating ? t('knowledgeGraph.createConnectedDocs') : t('knowledgeGraph.upgradeConnectedDocs'),
        label: t('knowledgeGraph.documentLabel'),
      },
    }));
  };

  if (graphKind === 'activity') return <div className="relative h-full"><div className="absolute left-4 top-4 z-20 flex rounded-lg border border-surface-700 bg-surface-900/95 p-0.5"><button type="button" onClick={() => setGraphKind('documents')} className="rounded-md px-3 py-1.5 text-xs font-semibold text-surface-400 hover:text-surface-100">{t('knowledgeGraph.documentRelations')}</button><button type="button" className="tone-accent tone-action rounded-md px-3 py-1.5 text-xs font-semibold">{t('knowledgeGraph.activity')}</button></div><ProjectActivityGraph projectId={projectId} onOpenFile={onOpenFile} onOpenSession={onOpenSession} /></div>;
  if (loading) return <div className="grid h-full min-h-[560px] place-items-center text-sm text-surface-500">{t('knowledgeGraph.loading')}</div>;
  if (error) return <div className="grid h-full min-h-[560px] place-items-center px-6 text-center text-sm text-red-400">{error}</div>;
  if (!data) return null;

  return (
    <div className="relative h-full min-h-[560px] overflow-hidden bg-surface-950">
      <div className="absolute left-4 right-4 top-4 z-10 flex flex-wrap items-center gap-2 rounded-2xl border border-surface-700 bg-surface-900/95 p-2 shadow-xl backdrop-blur">
        <div className="flex rounded-lg border border-surface-700 p-0.5"><button type="button" className="tone-accent tone-action rounded-md px-3 py-1.5 text-xs font-semibold">{t('knowledgeGraph.documentRelations')}</button><button type="button" onClick={() => setGraphKind('activity')} className="rounded-md px-3 py-1.5 text-xs font-semibold text-surface-400 hover:text-surface-100">{t('knowledgeGraph.activity')}</button></div>
        <div className="flex rounded-lg border border-surface-700 p-0.5">
          <button type="button" onClick={() => setMode('global')} className={`rounded-md px-3 py-1.5 text-xs font-semibold ${mode === 'global' ? 'tone-accent tone-action' : 'text-surface-400 hover:text-surface-100'}`}>{t('knowledgeGraph.all')}</button>
          <button type="button" disabled={!selectedId} onClick={() => setMode('local')} className={`rounded-md px-3 py-1.5 text-xs font-semibold ${mode === 'local' ? 'tone-accent tone-action' : 'text-surface-400 hover:text-surface-100 disabled:opacity-40'}`}>{t('knowledgeGraph.nearby')}</button>
        </div>
        {mode === 'local' && <select value={depth} onChange={(event) => setDepth(Number(event.target.value))} className="rounded-lg border border-surface-700 bg-surface-950 px-2 py-1.5 text-xs text-surface-200"><option value={1}>{t('knowledgeGraph.depth',{count:1})}</option><option value={2}>{t('knowledgeGraph.depth',{count:2})}</option><option value={3}>{t('knowledgeGraph.depth',{count:3})}</option></select>}
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('knowledgeGraph.searchPlaceholder')} className="min-w-48 flex-1 rounded-lg border border-surface-700 bg-surface-950 px-3 py-1.5 text-xs text-surface-100 outline-none placeholder:text-surface-600 focus:border-primary-500" />
        <label className="flex items-center gap-1.5 text-[11px] text-surface-400"><input type="checkbox" checked={hideOrphans} onChange={(event) => setHideOrphans(event.target.checked)} />{t('knowledgeGraph.hideOrphans')}</label>
        <label className="flex items-center gap-1.5 text-[11px] text-surface-400"><input type="checkbox" checked={showUnresolved} onChange={(event) => setShowUnresolved(event.target.checked)} />{t('knowledgeGraph.showUnresolved')}</label>
        <span className="text-[11px] text-surface-500">{t('knowledgeGraph.summary',{nodes:graphData.nodes.length,links:graphData.links.length,status:layoutSettled?t('knowledgeGraph.settled'):t('knowledgeGraph.settling')})}</span>
        <button type="button" onClick={() => startConnectedDocsSession(data.summary.edges > 0 ? 'upgrade' : 'create')} className="rounded-lg border border-primary-500/35 bg-primary-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-primary-700 hover:bg-primary-500/15 dark:text-primary-200">{data.summary.edges > 0?t('knowledgeGraph.upgradeConnectedDocs'):t('knowledgeGraph.createConnectedDocs')}</button>
        <button type="button" onClick={() => { setLayoutSettled(false); graphRef.current?.d3ReheatSimulation(); }} className="rounded-lg border border-surface-700 px-2.5 py-1.5 text-[11px] font-semibold text-surface-300 hover:bg-surface-800 hover:text-surface-100">{t('knowledgeGraph.relayout')}</button>
      </div>

      <div ref={containerRef} className="h-full min-h-[560px] w-full" />

      <div className="pointer-events-none absolute bottom-4 left-4 z-10 rounded-xl border border-surface-800 bg-surface-900/90 px-3 py-2 text-[10px] text-surface-500 backdrop-blur">
        {t('knowledgeGraph.legend')}
      </div>

      {selectedNode && (
        <aside className="absolute bottom-4 right-4 z-10 w-[min(22rem,calc(100%-2rem))] rounded-2xl border border-surface-700 bg-surface-900/95 p-4 shadow-2xl backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-surface-100">{selectedNode.label}</div>
              <div className="mt-1 break-all font-mono text-[10px] text-surface-500">{selectedNode.path}</div>
              <div className="mt-2 text-[11px] text-surface-400">{t('knowledgeGraph.selectedSummary',{kind:selectedKindLabel,incoming:selectedConnections.incoming,outgoing:selectedConnections.outgoing})}</div>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            {!selectedNode.unresolved && <button type="button" onClick={() => onOpenFile(`${rootPath}/${selectedNode.path}`)} className="tone-accent tone-action rounded-lg px-3 py-2 text-xs font-semibold">{t('knowledgeGraph.openDocument')}</button>}
            <button type="button" onClick={() => { setMode('local'); setDepth(1); }} className="rounded-lg border border-surface-700 px-3 py-2 text-xs font-semibold text-surface-300 hover:bg-surface-800 hover:text-surface-100">{t('knowledgeGraph.focusDocument')}</button>
          </div>
        </aside>
      )}
    </div>
  );
}
