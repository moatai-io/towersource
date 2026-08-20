import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { ProcessMap, ProcessNode } from '@tower/shared';

type PanelMode = 'auto' | 'pinned' | 'collapsed';
type CommandScope = { type: 'latest' } | { type: 'node'; nodeId: string };

const MIN_PANEL_WIDTH = 320;
const DEFAULT_PANEL_WIDTH = 380;
const MAX_PANEL_WIDTH = 620;

async function fetchJson<T>(url: string): Promise<T> {
  const token = localStorage.getItem('token');
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function clampWidth(width: number): number {
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(width)));
}

function storageKey(sessionId: string | null, key: 'mode' | 'width' | 'dismissedMapId'): string {
  return `tower:process-map:${sessionId || 'global'}:${key}`;
}

function nodeGlyph(node: ProcessNode): string {
  switch (node.kind) {
    case 'user_intent': return '◎';
    case 'command': return '⌘';
    case 'skill': return '✦';
    case 'tool_step': return '⚙';
    case 'human_review': return 'H';
    case 'decision': return '◇';
    case 'artifact': return '▣';
    case 'blocker': return '!';
    case 'automation_candidate': return '↻';
    case 'data_input': return '↓';
    default: return '•';
  }
}

function ownerLabel(owner: ProcessNode['owner']): string {
  switch (owner) {
    case 'ai': return 'AI';
    case 'human': return 'Human';
    case 'system': return 'System';
    case 'external': return 'External';
    default: return owner;
  }
}

function automationLabel(level: ProcessNode['automationLevel']): string {
  switch (level) {
    case 'manual': return 'manual';
    case 'assisted': return 'assisted';
    case 'semi_auto': return 'semi-auto';
    case 'auto': return 'auto';
    default: return level;
  }
}

function statusLabel(status: ProcessNode['status'], t: TFunction<'chat'>): string {
  switch (status) {
    case 'completed': return t('runCanvas.status.completed');
    case 'running': return t('runCanvas.status.running');
    case 'failed': return t('runCanvas.status.failed');
    case 'blocked': return t('runCanvas.status.blocked');
    case 'skipped': return t('runCanvas.status.skipped');
    case 'pending': return t('runCanvas.status.pending');
    default: return status;
  }
}

function statusTone(status: ProcessNode['status']): { text: string; fill: string; border: string; wash: string; line: string } {
  if (status === 'completed') return {
    text: 'text-[var(--tone-success-text)]',
    fill: 'bg-[var(--tone-success-text)]',
    border: 'border-[var(--tone-success-border)]',
    wash: 'bg-[var(--tone-success-bg)]',
    line: 'bg-[var(--tone-success-text)]',
  };
  if (status === 'running') return {
    text: 'text-[var(--tone-info-text)]',
    fill: 'bg-[var(--tone-info-text)]',
    border: 'border-[var(--tone-info-border)]',
    wash: 'bg-[var(--tone-info-bg)]',
    line: 'bg-[var(--tone-info-text)]',
  };
  if (status === 'failed' || status === 'blocked') return {
    text: 'text-[var(--tone-danger-text)]',
    fill: 'bg-[var(--tone-danger-text)]',
    border: 'border-[var(--tone-danger-border)]',
    wash: 'bg-[var(--tone-danger-bg)]',
    line: 'bg-[var(--tone-danger-text)]',
  };
  return {
    text: 'text-[var(--tone-muted-text)]',
    fill: 'bg-[var(--tone-muted-text)]',
    border: 'border-[var(--tone-muted-border)]',
    wash: 'bg-[var(--tone-muted-bg)]',
    line: 'bg-[var(--tone-muted-text)]',
  };
}

function evidenceLabel(node: ProcessNode): string | null {
  const events = node.evidence?.eventIds?.length || 0;
  const logs = node.evidence?.logs?.length || 0;
  if (!events && !logs) return null;
  return `${events ? `${events} event${events === 1 ? '' : 's'}` : ''}${events && logs ? ' · ' : ''}${logs ? `${logs} log${logs === 1 ? '' : 's'}` : ''}`;
}

function cleanMapTitle(title: string): string {
  return title.replace(/ Run Canvas$/, '').replace(/ Process map$/i, '').replace(/^Skill ·\s*/i, '');
}

function mapStatusFromNode(status: ProcessNode['status']): ProcessMap['status'] {
  if (status === 'running') return 'running';
  if (status === 'failed') return 'failed';
  if (status === 'blocked') return 'blocked';
  if (status === 'pending') return 'draft';
  return 'completed';
}

function commandNameFromNode(node: ProcessNode): string {
  const cleaned = cleanMapTitle(node.label).trim();
  const fromLog = node.evidence?.logs
    ?.map((log) => log.match(/(?:Skill|Command) (?:started|completed):\s*([^\s]+)/i)?.[1])
    .find(Boolean);
  return String(fromLog || cleaned).replace(/^\/+/, '').trim();
}

function isProcessMapWriteMap(map: ProcessMap | null): boolean {
  return map?.sourceRefs?.source === 'ProcessMapWrite';
}

function executionNodesFromMap(map: ProcessMap | null): ProcessNode[] {
  if (!map || isProcessMapWriteMap(map)) return [];
  return map.nodes.filter((node) => (node.kind === 'command' || node.kind === 'skill') && !node.id.includes(':runtime:'));
}

function commandRuntimeNodesForExecution(map: ProcessMap, execution: ProcessNode): ProcessNode[] {
  const prefix = `${execution.id}:runtime:`;
  const runtimeNodes = map.nodes.filter((node) => node.id.startsWith(prefix));
  return runtimeNodes.length ? runtimeNodes : [execution];
}

function commandProcessMap(map: ProcessMap | null, commandScope: CommandScope): ProcessMap | null {
  if (!map) return null;
  if (isProcessMapWriteMap(map)) return map;
  const executionNodes = executionNodesFromMap(map);
  const latestExecution = executionNodes[executionNodes.length - 1];
  const selectedExecution = commandScope.type === 'node'
    ? executionNodes.find((node) => node.id === commandScope.nodeId) || latestExecution
    : latestExecution;
  if (!selectedExecution) return null;
  const runtimeNodes = commandRuntimeNodesForExecution(map, selectedExecution);
  const commandName = commandNameFromNode(selectedExecution);
  return {
    ...map,
    id: `${map.id}:command:${selectedExecution.id}`,
    title: commandName,
    status: mapStatusFromNode(selectedExecution.status),
    sourceRefs: {
      ...map.sourceRefs,
      scope: commandScope.type === 'node' ? 'selected_command' : 'latest_command',
      executionNodeId: selectedExecution.id,
      commandName,
    },
    nodes: runtimeNodes,
    edges: [],
  };
}

function ProcessMapTrace({ map, loading, onReload }: { map: ProcessMap | null; loading: boolean; onReload: () => void }) {
  const { t } = useTranslation('chat');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const nodes = map?.nodes || [];
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) || nodes.find((node) => node.status === 'running') || nodes.find((node) => node.kind === 'command' || node.kind === 'skill') || nodes[0] || null;
  const completed = nodes.filter((node) => node.status === 'completed').length;
  const progress = nodes.length ? Math.round((completed / nodes.length) * 100) : 0;
  const routeLabel = 'Command process';

  useEffect(() => {
    if (!selectedNodeId && selectedNode?.id) setSelectedNodeId(selectedNode.id);
    if (selectedNodeId && !nodes.some((node) => node.id === selectedNodeId)) setSelectedNodeId(selectedNode?.id || null);
  }, [nodes, selectedNode?.id, selectedNodeId]);

  if (loading && !map) {
    return (
      <div className="rounded-2xl border border-[var(--th-border-subtle)] bg-[var(--th-bg-secondary)] p-4 text-[13px] text-[var(--th-text-secondary)]">
        {t('runCanvas.loading')}
      </div>
    );
  }

  if (!map) {
    return (
      <div className="rounded-2xl border border-dashed border-[var(--th-border-subtle)] bg-[var(--th-bg-secondary)] p-4">
        <div className="text-[13px] font-semibold text-[var(--th-text-primary)]">{t('runCanvas.emptyTitle')}</div>
        <p className="mt-1 text-[12px] leading-5 text-[var(--th-text-muted)]">{t('runCanvas.emptyDescription')}</p>
        <button type="button" onClick={onReload} className="mt-3 rounded-lg border border-[var(--th-border-subtle)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--th-text-secondary)] hover:border-[var(--th-border)] hover:text-[var(--th-text-primary)]">{t('runCanvas.checkAgain')}</button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <section className="rounded-2xl border border-[var(--th-border-subtle)] bg-[var(--th-bg-secondary)] p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-black uppercase tracking-[0.2em] text-[var(--th-text-muted)]">{routeLabel}</div>
            <div className="mt-1 truncate text-[13px] font-bold text-[var(--th-text-primary)]">{cleanMapTitle(map.title)}</div>
          </div>
          <button type="button" onClick={onReload} className="shrink-0 rounded-lg border border-[var(--th-border-subtle)] bg-[var(--th-bg-primary)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--th-text-secondary)] hover:border-[var(--th-border)] hover:text-[var(--th-text-primary)]">{t('runCanvas.reload')}</button>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--tone-muted-bg)]">
            <div className="h-full rounded-full bg-[var(--th-accent-500)] transition-all" style={{ width: `${progress}%` }} />
          </div>
          <span className="text-[11px] font-bold tabular-nums text-[var(--th-text-muted)]">{progress}%</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] font-semibold uppercase tracking-wide">
          <span className="rounded-full border border-[var(--th-border-subtle)] bg-[var(--th-bg-primary)] px-2 py-0.5 text-[var(--th-text-muted)]">{map.status}</span>
          <span className="rounded-full border border-[var(--th-border-subtle)] bg-[var(--th-bg-primary)] px-2 py-0.5 text-[var(--th-text-muted)]">{nodes.length} stops</span>
          <span className="rounded-full border border-[var(--th-border-subtle)] bg-[var(--th-bg-primary)] px-2 py-0.5 text-[var(--th-text-muted)]">{completed} done</span>
        </div>
      </section>

      <section className="rounded-2xl border border-[var(--th-border-subtle)] bg-[var(--th-bg-primary)] px-3 py-4">
        <div className="relative">
          <div className="absolute left-[16px] top-4 bottom-4 w-[2px] rounded-full bg-[var(--th-border-subtle)]" />
          <div className="space-y-1">
            {nodes.map((node, index) => {
              const tone = statusTone(node.status);
              const selected = selectedNode?.id === node.id;
              const isLast = index === nodes.length - 1;
              return (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => setSelectedNodeId(node.id)}
                  className={`group relative grid w-full grid-cols-[34px_minmax(0,1fr)] gap-3 rounded-xl py-2 pr-2 text-left transition ${selected ? 'bg-[var(--th-bg-secondary)]' : 'hover:bg-[var(--th-bg-secondary)]'}`}
                >
                  {!isLast && <span className={`absolute left-[16px] top-9 h-[calc(100%+4px)] w-[2px] rounded-full ${tone.line} opacity-55`} />}
                  <span className="relative z-10 grid h-8 w-[34px] place-items-center">
                    <span className={`grid h-7 w-7 place-items-center rounded-full border bg-[var(--th-bg-primary)] text-[12px] font-black ${tone.border} ${tone.text} ${selected ? 'shadow-sm' : ''}`}>{nodeGlyph(node)}</span>
                  </span>
                  <span className="min-w-0 border-b border-[var(--th-border-subtle)] pb-2 group-last:border-b-0">
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-bold leading-5 text-[var(--th-text-primary)]">{node.label}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-[var(--th-text-muted)]">{node.kind.replace(/_/g, ' ')} · {ownerLabel(node.owner)} · {automationLabel(node.automationLevel)}</span>
                      </span>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone.border} ${tone.wash} ${tone.text}`}>{statusLabel(node.status, t)}</span>
                    </span>
                    {node.summary ? <span className="mt-1.5 line-clamp-2 block text-[12px] leading-4 text-[var(--th-text-secondary)]">{node.summary}</span> : null}
                    {selected ? (
                      <span className="mt-2 block border-l-2 border-[var(--th-border-subtle)] pl-3">
                        <span className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--th-text-muted)]">
                          <span>{t('runCanvas.owner')} <b className="font-semibold text-[var(--th-text-primary)]">{ownerLabel(node.owner)}</b></span>
                          <span>{t('runCanvas.automation')} <b className="font-semibold text-[var(--th-text-primary)]">{automationLabel(node.automationLevel)}</b></span>
                          {evidenceLabel(node) ? <span>{t('runCanvas.evidence')} <b className="font-semibold text-[var(--th-text-primary)]">{evidenceLabel(node)}</b></span> : null}
                        </span>
                        {node.evidence?.logs?.length ? (
                          <span className="mt-2 block rounded-lg bg-[var(--th-bg-primary)] px-2 py-1.5 text-[11px] leading-4 text-[var(--th-text-secondary)]">
                            {node.evidence.logs.slice(0, 2).map((log, i) => <span key={i} className="line-clamp-2 block">{log}</span>)}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

function buildAutomationScoutPrompt(map: ProcessMap, sessionId: string | null): string {
  const lines = map.nodes.map((node, index) => {
    const summary = node.summary ? ` — ${node.summary}` : '';
    const evidence = node.evidence?.files?.length ? ` files=${node.evidence.files.join(', ')}` : '';
    return `${index + 1}. [${node.status}] ${node.label}${summary}${evidence}`;
  }).join('\n');
  const commandName = cleanMapTitle(map.title);
  return [
    '이 Process Map 흐름을 자동화/스킬화 후보로 분석해줘.',
    '',
    '중요: 새 사이드바 세션을 spawn하지 말고, 이 현재 세션을 parent/supervisor로 두고 Automation Scout subagent를 사용해 분석해줘.',
    'subagent는 실제 파일 수정, 스킬 생성, schedule 생성, 배포, 커밋을 하지 말고 후보 브리프만 작성해야 해.',
    '',
    '원 세션 정보:',
    `- sessionId: ${sessionId || 'unknown'}`,
    `- selected process: ${commandName}`,
    `- processMapId: ${map.id}`,
    '',
    'Process Map 요약:',
    lines || '- 단계 없음',
    '',
    'Automation Scout가 판단할 것:',
    '1. 반복 업무의 목적 한 문장',
    '2. 고정 단계와 변동 단계',
    '3. 사용자 입력/승인 지점',
    '4. 산출물과 검증 기준',
    '5. 기존 skill refinement 후보 또는 새 skill 후보',
    '6. 추천 경로: skill / skill_refinement / code_command / schedule_trigger / defer',
    '',
    '보고는 결론, 추천 경로, Automation brief, 근거, 내가 사용자에게 물어볼 다음 질문 순서로 짧게 정리해줘.',
  ].join('\n');
}

function ProcessMapRail({ hasProcess, runningCount, stepCount, onOpen }: { hasProcess: boolean; runningCount: number; stepCount: number; onOpen: () => void }) {
  const { t } = useTranslation('chat');
  return (
    <aside className="hidden h-full w-12 shrink-0 border-l border-[var(--th-border-subtle)] bg-[var(--th-bg-primary)] xl:flex">
      <button
        type="button"
        onClick={onOpen}
        className="relative flex h-full w-full items-center justify-center text-[var(--th-text-muted)] hover:text-[var(--th-text-primary)]"
        title={t('runCanvas.expand')}
      >
        {hasProcess && <span className={`absolute top-3 h-2 w-2 rounded-full bg-[var(--th-accent-500)] ${runningCount > 0 ? 'animate-pulse' : ''}`} />}
        <span className="-rotate-90 whitespace-nowrap text-[12px] font-bold tracking-wider">{t('runCanvas.expand')}{stepCount > 0 ? ` · ${t('runCanvas.stepCount', { count: stepCount })}` : ''}</span>
      </button>
    </aside>
  );
}

export function RunCanvasPanel({ sessionId, refreshKey = 0 }: { sessionId: string | null; refreshKey?: number }) {
  const { t } = useTranslation('chat');
  const [map, setMap] = useState<ProcessMap | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<PanelMode>('auto');
  const [width, setWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [automationConfirmOpen, setAutomationConfirmOpen] = useState(false);
  const [automationStarting, setAutomationStarting] = useState(false);
  const [automationScoutSessionId, setAutomationScoutSessionId] = useState<string | null>(null);
  const [dismissedMapId, setDismissedMapId] = useState<string | null>(null);

  const [commandScope, setCommandScope] = useState<CommandScope>({ type: 'latest' });

  const processMapWriteActive = isProcessMapWriteMap(map);
  const executionNodes = useMemo(() => executionNodesFromMap(map), [map]);
  const executionOptions = useMemo(() => [...executionNodes].reverse(), [executionNodes]);
  const commandMap = useMemo(() => commandProcessMap(map, commandScope), [map, commandScope]);
  const selectedExecutionId = commandMap?.sourceRefs?.executionNodeId as string | undefined;
  const selectedExecution = useMemo(() => selectedExecutionId ? executionNodes.find((node) => node.id === selectedExecutionId) || null : executionOptions[0] || null, [executionNodes, executionOptions, selectedExecutionId]);
  const runningCount = useMemo(() => commandMap?.nodes.filter((node) => node.status === 'running').length || 0, [commandMap]);
  const meaningfulNodes = useMemo(() => commandMap?.nodes.filter((node) => node.id !== 'no-events') || [], [commandMap]);
  const stepCount = meaningfulNodes.length;
  const hasProcess = Boolean(commandMap);
  const currentMapId = commandMap?.id || null;
  const isOpen = mode === 'pinned' || (mode === 'auto' && hasProcess && currentMapId !== dismissedMapId);

  useEffect(() => {
    if (processMapWriteActive) return;
    if (commandScope.type === 'node' && !executionNodes.some((node) => node.id === commandScope.nodeId)) setCommandScope({ type: 'latest' });
  }, [commandScope, executionNodes, processMapWriteActive]);

  useEffect(() => {
    const savedMode = localStorage.getItem(storageKey(sessionId, 'mode')) as PanelMode | null;
    const legacyCollapsed = localStorage.getItem('tower:chat-run-canvas-collapsed') === '1';
    setMode(savedMode === 'pinned' ? 'pinned' : legacyCollapsed ? 'collapsed' : 'auto');
    setDismissedMapId(localStorage.getItem(storageKey(sessionId, 'dismissedMapId')) || null);

    const savedWidth = Number(localStorage.getItem(storageKey(sessionId, 'width')) || '');
    setWidth(Number.isFinite(savedWidth) && savedWidth > 0 ? clampWidth(savedWidth) : DEFAULT_PANEL_WIDTH);
  }, [sessionId]);

  useEffect(() => {
    localStorage.setItem(storageKey(sessionId, 'mode'), mode);
  }, [mode, sessionId]);

  useEffect(() => {
    localStorage.setItem(storageKey(sessionId, 'width'), String(width));
  }, [width, sessionId]);

  useEffect(() => {
    if (dismissedMapId) localStorage.setItem(storageKey(sessionId, 'dismissedMapId'), dismissedMapId);
    else localStorage.removeItem(storageKey(sessionId, 'dismissedMapId'));
  }, [dismissedMapId, sessionId]);

  useEffect(() => {
    if (!currentMapId || mode !== 'collapsed') return;
    if (currentMapId !== dismissedMapId) setMode('auto');
  }, [currentMapId, dismissedMapId, mode]);

  const load = useCallback(async () => {
    if (!sessionId) {
      setMap(null);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      setMap(await fetchJson<ProcessMap>(`/api/sessions/${sessionId}/process-map`));
    } catch (err: any) {
      setError(err?.message || t('runCanvas.loadFailed'));
      setMap(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const startAutomationScout = useCallback(async () => {
    if (!sessionId || !commandMap) return;
    const prompt = buildAutomationScoutPrompt(commandMap, sessionId);
    try {
      setAutomationStarting(true);
      setError(null);
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/sessions/${sessionId}/process-map/automation-scout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ prompt, processMapId: commandMap.id, selectedExecutionId }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setAutomationScoutSessionId(typeof data?.sessionId === 'string' ? data.sessionId : null);
      setAutomationConfirmOpen(false);
    } catch (err: any) {
      setError(err?.message || t('runCanvas.automationStartFailed'));
    } finally {
      setAutomationStarting(false);
    }
  }, [commandMap, selectedExecutionId, sessionId, t]);

  const startResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const handleMove = (moveEvent: PointerEvent) => {
      setWidth(clampWidth(startWidth + startX - moveEvent.clientX));
    };
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp, { once: true });
  }, [width]);

  if (!isOpen) {
    return <ProcessMapRail hasProcess={hasProcess} runningCount={runningCount} stepCount={stepCount} onOpen={() => { setDismissedMapId(null); setMode('pinned'); }} />;
  }

  return (
    <aside className="relative hidden h-full shrink-0 flex-col border-l border-[var(--th-border-subtle)] bg-[var(--th-bg-primary)] xl:flex" style={{ width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        title={t('runCanvas.resize')}
        onPointerDown={startResize}
        onDoubleClick={() => setWidth(DEFAULT_PANEL_WIDTH)}
        className="group absolute left-0 top-0 z-20 h-full w-2 -translate-x-1 cursor-col-resize touch-none"
      >
        <span className="mx-auto block h-full w-px bg-transparent transition group-hover:bg-[var(--th-border)]" />
      </div>
      <div className="flex items-center justify-between gap-3 border-b border-[var(--th-border-subtle)] px-3 py-2">
        <div className="min-w-0">
          <div className="text-[12px] font-bold uppercase tracking-wider text-[var(--th-text-primary)]">Process Map</div>
          <div className="truncate text-[11px] text-[var(--th-text-muted)]">
            {commandMap ? cleanMapTitle(commandMap.title) : t('runCanvas.waitingForRun')}{processMapWriteActive ? ` · ${t('runCanvas.liveMap')}` : ''}{runningCount > 0 ? ` · ${t('runCanvas.runningCount', { count: runningCount })}` : ''}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {commandMap ? (
            <button
              type="button"
              onClick={() => setAutomationConfirmOpen(true)}
              className="rounded-md border border-[var(--tone-accent-border)] bg-[var(--tone-accent-bg)] px-2 py-1 text-[11px] font-semibold text-[var(--tone-accent-text)] hover:brightness-105"
              title={t('runCanvas.analyzeAutomationTitle')}
            >
              {t('runCanvas.analyzeAutomation')}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => { setDismissedMapId(currentMapId); setMode('collapsed'); }}
            className="rounded-md border border-[var(--th-border-subtle)] px-2 py-1 text-[11px] text-[var(--th-text-secondary)] hover:border-[var(--th-border)] hover:text-[var(--th-text-primary)]"
            title={t('runCanvas.collapse')}
          >
            {t('runCanvas.collapse')}
          </button>
        </div>
      </div>
      {!processMapWriteActive && executionOptions.length > 0 ? (
        <div className="border-b border-[var(--th-border-subtle)] px-3 py-2">
          <label className="flex items-center gap-2 text-[11px] text-[var(--th-text-muted)]">
            <span className="shrink-0 font-bold text-[var(--th-text-secondary)]">{t('runCanvas.selectRun')}</span>
            <select
              value={selectedExecutionId || 'latest'}
              onChange={(event) => setCommandScope(event.target.value === 'latest' ? { type: 'latest' } : { type: 'node', nodeId: event.target.value })}
              className="min-w-0 flex-1 rounded-md border border-[var(--th-border-subtle)] bg-[var(--th-bg-primary)] px-2 py-1.5 text-[11px] font-semibold text-[var(--th-text-secondary)] outline-none hover:border-[var(--th-border)] hover:text-[var(--th-text-primary)]"
              title={t('runCanvas.selectRunTitle')}
            >
              <option value="latest">{t('runCanvas.latestRun')}</option>
              {executionOptions.map((node, index) => (
                <option key={node.id} value={node.id}>{index === 0 ? `${t('runCanvas.latest')} · ` : ''}{node.kind === 'command' ? '⌘' : '✦'} {commandNameFromNode(node)} · {statusLabel(node.status, t)}</option>
              ))}
            </select>
          </label>
          {selectedExecution ? (
            <div className="mt-2 rounded-lg border border-[var(--th-border-subtle)] bg-[var(--th-bg-secondary)] px-2.5 py-2 text-[11px] leading-4 text-[var(--th-text-secondary)]">
              <div className="flex flex-wrap gap-x-2 gap-y-1">
                <span className="font-bold text-[var(--th-text-primary)]">{selectedExecution.kind === 'skill' ? 'Skill' : 'Command'}</span>
                <span>{commandNameFromNode(selectedExecution)}</span>
                <span>· {statusLabel(selectedExecution.status, t)}</span>
              </div>
              {selectedExecution.summary ? <div className="mt-1 line-clamp-2 text-[var(--th-text-muted)]">{selectedExecution.summary}</div> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {automationConfirmOpen ? (
        <div className="m-3 rounded-2xl border border-[var(--tone-accent-border)] bg-[var(--tone-accent-bg)] p-3 text-[12px] text-[var(--tone-accent-text)] shadow-lg">
          <div className="font-bold text-[var(--th-text-primary)]">{t('runCanvas.confirmAutomationTitle')}</div>
          <p className="mt-1 leading-5 text-[var(--th-text-secondary)]">{t('runCanvas.confirmAutomationDescription')}</p>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setAutomationConfirmOpen(false)} className="rounded-md border border-[var(--th-border-subtle)] bg-[var(--th-bg-primary)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--th-text-secondary)] hover:text-[var(--th-text-primary)]">{t('runCanvas.cancel')}</button>
            <button type="button" onClick={startAutomationScout} disabled={automationStarting} className="rounded-md border border-[var(--tone-accent-border)] bg-[var(--tone-accent-bg)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--tone-accent-text)] disabled:opacity-60">{automationStarting ? t('runCanvas.starting') : t('runCanvas.startAnalysis')}</button>
          </div>
        </div>
      ) : null}
      {automationScoutSessionId ? (
        <div className="mx-3 mt-3 rounded-2xl border border-[var(--tone-success-border)] bg-[var(--tone-success-bg)] p-3 text-[12px] text-[var(--tone-success-text)]">
          <div className="font-bold text-[var(--th-text-primary)]">{t('runCanvas.scoutStartedTitle')}</div>
          <p className="mt-1 text-[var(--th-text-secondary)]">{t('runCanvas.scoutStartedDescription')}</p>
          <a href={`/s/${automationScoutSessionId}`} target="_blank" rel="noreferrer" className="mt-2 inline-flex rounded-md border border-[var(--tone-success-border)] bg-[var(--th-bg-primary)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--tone-success-text)] hover:brightness-105">{t('runCanvas.openSubagentSession')}</a>
        </div>
      ) : null}
      {error ? (
        <div className="m-3 rounded-xl border border-[var(--tone-danger-border)] bg-[var(--tone-danger-bg)] p-3 text-[12px] text-[var(--tone-danger-text)]">{error}</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <ProcessMapTrace map={commandMap} loading={loading} onReload={load} />
        </div>
      )}
    </aside>
  );
}
