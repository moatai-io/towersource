import React from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '@tower/shared';
import { loadTeamConnections, type TeamConnections as ConnectionData } from './data';

const MAX_PEOPLE = 8;
const AGENTS_PER_RING = 10;
const GRAPH_WIDTH = 720;
const GRAPH_HEIGHT = 300;
const GRAPH_CENTER_X = GRAPH_WIDTH / 2;
const GRAPH_CENTER_Y = GRAPH_HEIGHT / 2 + 4;

function compactName(value: string, limit = 16): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function initials(value: string): string {
  return value.trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || '?';
}

interface NodePoint { x: number; y: number; labelX: number; labelAnchor: 'start' | 'end' }

function ellipsePoint(index: number, count: number, radiusX: number, radiusY: number, phase: number): NodePoint {
  const angle = phase + (Math.PI * 2 * index) / Math.max(1, count);
  const x = GRAPH_CENTER_X + Math.cos(angle) * radiusX;
  const y = GRAPH_CENTER_Y + Math.sin(angle) * radiusY;
  const onRight = x >= GRAPH_CENTER_X;
  return { x, y, labelX: x + (onRight ? 25 : -25), labelAnchor: onRight ? 'start' : 'end' };
}

function agentRingPoint(index: number, count: number): NodePoint {
  const ringCount = Math.max(1, Math.ceil(count / AGENTS_PER_RING));
  const ring = index % ringCount;
  const ringIndex = Math.floor(index / ringCount);
  const nodesInRing = Math.ceil((count - ring) / ringCount);
  const radiusX = Math.min(148, 70 + ring * 38);
  const radiusY = Math.min(84, 38 + ring * 22);
  return ellipsePoint(ringIndex, nodesInRing, radiusX, radiusY, -Math.PI / 2 + ring * 0.18);
}

/** A compact, stable people-to-AI membership map. It deliberately does not infer actual work from private activity. */
export function TeamConnections({ projects, onOpenProject }: { projects: Project[]; onOpenProject: (project: Project) => void }) {
  const { t } = useTranslation('layout');
  const agents = projects.filter(project => !project.systemKey && !project.archived);
  const idsKey = JSON.stringify(agents.map(project => project.id).sort());
  const [data, setData] = React.useState<ConnectionData | null>(null);
  const [revision, refresh] = React.useReducer(value => value + 1, 0);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [focusedNode, setFocusedNode] = React.useState<string | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    setData(null);
    loadTeamConnections(JSON.parse(idsKey), controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setData(result);
      setStatus('ready');
    }).catch(() => {
      if (!controller.signal.aborted) setStatus('error');
    });
    return () => controller.abort();
  }, [idsKey, revision]);

  React.useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const people = data?.people || [];
  const allConnections = agents.flatMap(agent => (data?.members[agent.id] || []).map(member => ({
    personId: member.userId,
    agentId: agent.id,
    key: `${member.userId}-${agent.id}`,
  })));
  const personDegree = new Map<number, number>();
  const agentDegree = new Map<string, number>();
  allConnections.forEach(connection => {
    personDegree.set(connection.personId, (personDegree.get(connection.personId) || 0) + 1);
    agentDegree.set(connection.agentId, (agentDegree.get(connection.agentId) || 0) + 1);
  });
  const visiblePeople = people.slice().sort((a, b) => (personDegree.get(b.id) || 0) - (personDegree.get(a.id) || 0) || a.username.localeCompare(b.username)).slice(0, MAX_PEOPLE);
  const visibleAgents = agents.slice().sort((a, b) => (agentDegree.get(b.id) || 0) - (agentDegree.get(a.id) || 0) || a.name.localeCompare(b.name));
  const personPoints = new Map(visiblePeople.map((person, index) => [person.id, ellipsePoint(index, visiblePeople.length, 250, 108, -Math.PI / 2)]));
  const agentPoints = new Map(visibleAgents.map((agent, index) => [agent.id, agentRingPoint(index, visibleAgents.length)]));
  const visibleConnections = allConnections.filter(connection => personPoints.has(connection.personId) && agentPoints.has(connection.agentId));
  const hiddenPeople = Math.max(0, people.length - visiblePeople.length);
  const hiddenAgents = 0;

  const isRelated = (personId: number, agentId: string): boolean => {
    if (!focusedNode) return true;
    return focusedNode === `person:${personId}` || focusedNode === `agent:${agentId}`;
  };
  const isPersonActive = (personId: number): boolean => {
    if (!focusedNode || focusedNode === `person:${personId}`) return true;
    const agentId = focusedNode.startsWith('agent:') ? focusedNode.slice(6) : null;
    return !!agentId && visibleConnections.some(connection => connection.personId === personId && connection.agentId === agentId);
  };
  const isAgentActive = (agentId: string): boolean => {
    if (!focusedNode || focusedNode === `agent:${agentId}`) return true;
    const personId = focusedNode.startsWith('person:') ? Number(focusedNode.slice(7)) : null;
    return personId !== null && visibleConnections.some(connection => connection.personId === personId && connection.agentId === agentId);
  };

  return <section className="mt-4 rounded-xl border border-surface-800 px-3 py-3" aria-labelledby="team-connections-title">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 id="team-connections-title" className="text-xs font-semibold text-surface-200">{t('teamConnections.title')}</h3>
        <p className="mt-0.5 text-[10px] text-surface-600">{t('teamConnections.networkScope')}</p>
      </div>
      <div className="flex items-center gap-3 text-[10px] text-surface-500">
        {data && <span>{t('teamConnections.population', { people: people.length, agents: agents.length, connections: allConnections.length })}</span>}
        <button type="button" disabled={status === 'loading'} onClick={refresh} className="rounded px-1 py-1 hover:text-surface-200 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-primary-400">{t('teamConnections.refresh')}</button>
      </div>
    </div>

    {status === 'loading' && <p role="status" className="py-3 text-xs text-surface-500">{t('teamConnections.loading')}</p>}
    {status === 'error' && <p role="alert" className="py-3 text-xs text-surface-400">{t('teamConnections.error')}</p>}
    {data && (people.length && agents.length ? <>
      <svg viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`} role="img" aria-labelledby="team-network-title team-network-description" className="mx-auto my-1 block h-auto w-full" preserveAspectRatio="xMidYMid meet" onMouseLeave={() => setFocusedNode(null)}>
        <title id="team-network-title">{t('teamConnections.networkTitle')}</title>
        <desc id="team-network-description">{t('teamConnections.networkDescription')}</desc>
        <ellipse cx={GRAPH_CENTER_X} cy={GRAPH_CENTER_Y} rx="164" ry="92" className="fill-primary-500/[0.025] stroke-surface-800" strokeDasharray="3 7" aria-hidden="true" />
        <text x={GRAPH_CENTER_X} y={GRAPH_CENTER_Y - 111} textAnchor="middle" className="fill-surface-600 text-[9px] font-semibold">{t('teamConnections.aiNodes')}</text>
        <text x="24" y="18" className="fill-surface-600 text-[9px] font-semibold">{t('teamConnections.peopleNodes')}</text>

        <g aria-hidden="true">
          {visibleConnections.map(connection => {
            const personPoint = personPoints.get(connection.personId)!;
            const agentPoint = agentPoints.get(connection.agentId)!;
            const related = isRelated(connection.personId, connection.agentId);
            const controlX = (personPoint.x + agentPoint.x + GRAPH_CENTER_X) / 3;
            const controlY = (personPoint.y + agentPoint.y + GRAPH_CENTER_Y) / 3;
            return <path
              key={connection.key}
              data-connection={connection.key}
              d={`M ${personPoint.x} ${personPoint.y} Q ${controlX} ${controlY} ${agentPoint.x} ${agentPoint.y}`}
              className={`fill-none transition-opacity ${related ? 'stroke-primary-400/45 opacity-100' : 'stroke-surface-700 opacity-15'}`}
              strokeWidth={related && focusedNode ? 2 : 1.1}
            />;
          })}
        </g>

        {visiblePeople.map((person) => {
          const key = `person:${person.id}`;
          const point = personPoints.get(person.id)!;
          const active = isPersonActive(person.id);
          return <g key={key} role="button" tabIndex={0} aria-label={t('teamConnections.personNodeLabel', { name: person.username, count: personDegree.get(person.id) || 0 })} onMouseEnter={() => setFocusedNode(key)} onFocus={() => setFocusedNode(key)} onBlur={() => setFocusedNode(null)} className={`cursor-default transition-opacity ${active ? 'opacity-100' : 'opacity-35'}`}>
            <circle cx={point.x} cy={point.y} r="12" className="fill-surface-800 stroke-surface-600" />
            <text x={point.x} y={point.y + 2.5} textAnchor="middle" className="fill-surface-200 text-[7px] font-bold">{initials(person.username)}</text>
            <text x={point.x + (point.labelAnchor === 'start' ? 18 : -18)} y={point.y + 3} textAnchor={point.labelAnchor} className="fill-surface-400 text-[8px]">{compactName(person.username)}</text>
            <circle cx={point.x + 9} cy={point.y - 9} r="5.5" className="fill-surface-950 stroke-surface-700" />
            <text x={point.x + 9} y={point.y - 7} textAnchor="middle" className="fill-surface-400 text-[6px] font-semibold">{personDegree.get(person.id) || 0}</text>
          </g>;
        })}

        {visibleAgents.map((agent) => {
          const key = `agent:${agent.id}`;
          const point = agentPoints.get(agent.id)!;
          const name = agent.agent?.displayName || agent.name;
          const unavailable = data.unavailable.includes(agent.id);
          const active = isAgentActive(agent.id);
          const radius = 12 + Math.min(3, Math.ceil((agentDegree.get(agent.id) || 0) / 2));
          return <g key={key} role="button" tabIndex={0} aria-label={t('teamConnections.agentNodeLabel', { name, count: agentDegree.get(agent.id) || 0 })} onClick={() => onOpenProject(agent)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenProject(agent); } }} onMouseEnter={() => setFocusedNode(key)} onFocus={() => setFocusedNode(key)} onBlur={() => setFocusedNode(null)} className={`cursor-pointer transition-opacity ${active ? 'opacity-100' : 'opacity-35'}`}>
            <circle cx={point.x} cy={point.y} r={radius} className={unavailable ? 'fill-surface-800 stroke-surface-500 stroke-dashed' : 'fill-primary-500/15 stroke-primary-400/65'} />
            <text x={point.x} y={point.y + 2.5} textAnchor="middle" className="fill-primary-200 text-[7px] font-bold">{unavailable ? '?' : initials(name)}</text>
            <text x={point.x + (point.labelAnchor === 'start' ? radius + 5 : -radius - 5)} y={point.y + 3} textAnchor={point.labelAnchor} className="fill-surface-300 text-[8px] font-medium">{compactName(name, 12)}</text>
          </g>;
        })}
      </svg>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-surface-800 pt-2 text-[10px] text-surface-500">
        <span>{t('teamConnections.networkLegend')}</span>
        {(hiddenPeople > 0 || hiddenAgents > 0) && <span>{t('teamConnections.networkHidden', { people: hiddenPeople, agents: hiddenAgents })}</span>}
      </div>
    </> : <p className="py-3 text-xs text-surface-500">{t('teamConnections.empty')}</p>)}
    {data && data.unavailable.length > 0 && <p className="mt-1 text-[10px] text-surface-500">{t('teamConnections.partial', { count: data.unavailable.length })}</p>}
  </section>;
}
