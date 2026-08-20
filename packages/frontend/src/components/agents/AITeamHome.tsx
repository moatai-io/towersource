import React from 'react';
import { useTranslation } from 'react-i18next';
import { type AgentCareerLevel, type Project, type SessionMeta } from '@tower/shared';
import { isPureAgentSession } from '../../features/agent-sessions/classification';
import { AgentIdentityAvatar } from '../../features/agent-profile/AgentIdentityAvatar';

interface AITeamHomeProps {
  projects: Project[];
  sessions: SessionMeta[];
  activeSessionId: string | null;
  onSelectSession: (session: SessionMeta) => void;
  onNewSession: (projectId: string) => void;
  onOpenProjectHome: (project: Project) => void;
}

function latestConversation(projectId: string, sessions: SessionMeta[]): SessionMeta | null {
  return sessions
    .filter((session) => session.projectId === projectId && !isPureAgentSession(session))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime())[0] || null;
}

export function AITeamHome({ projects, sessions, activeSessionId, onSelectSession, onNewSession, onOpenProjectHome }: AITeamHomeProps) {
  const { t, i18n } = useTranslation('layout');
  const rootRef = React.useRef<HTMLElement>(null);
  const [filter,setFilter]=React.useState<'all'|AgentCareerLevel>('all');
  const [sort,setSort]=React.useState<'recent'|'created'|'name'>('recent');
  React.useLayoutEffect(() => {
    rootRef.current?.closest<HTMLElement>('[data-ai-team-scroll]')?.scrollTo({ top: 0 });
  }, []);
  const helper = projects.find((project) => project.systemKey === 'ai-talent-team');
  const teammates = projects.filter((project) => project.systemKey !== 'ai-talent-team' && !project.archived);
  const startCreator = () => window.dispatchEvent(new CustomEvent('tower-start-agent-academy'));
  const stats=React.useMemo(()=>teammates.map(project=>{const related=sessions.filter(session=>session.projectId===project.id&&!isPureAgentSession(session));const turns=Number((project as any).recentUsage?.recent7||0);const latest=related.reduce((max,session)=>Math.max(max,new Date(session.updatedAt||session.createdAt||0).getTime()),0);const level=(project.agent?.careerLevel||'intern') as AgentCareerLevel;return{project,sessions:related.length,turns,latest,level}}),[teammates,sessions]);
  const activeCount=stats.filter(item=>item.latest>Date.now()-14*864e5).length;
  const filteredBase=filter==='all'?stats:stats.filter(item=>item.level===filter);
  const filtered=[...filteredBase].sort((a,b)=>sort==='name'?(a.project.agent?.displayName||a.project.name).localeCompare(b.project.agent?.displayName||b.project.name, i18n.language):sort==='created'?new Date(b.project.createdAt||0).getTime()-new Date(a.project.createdAt||0).getTime():new Date((b.project as any).lastWorkedAt||0).getTime()-new Date((a.project as any).lastWorkedAt||0).getTime());
  const invited=filtered.filter(item=>(item.project as any).invitedByOther===true);
  const levelTitle=(level:AgentCareerLevel)=>level==='intern'?t('careerIntern'):level==='practitioner'?t('careerPractitioner'):level==='manager'?t('careerManager'):t('careerPartner');

  return (
    <section ref={rootRef} aria-labelledby="ai-team-home-title" className="ai-team-control-room agent-product-surface min-w-0 pb-8 [word-break:keep-all] [overflow-wrap:break-word]">
      <div className="ai-team-hero overflow-hidden rounded-3xl border p-5 sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="tone-accent tone-text text-[10px] font-bold uppercase tracking-[0.18em]">AI Team</div>
            <h2 id="ai-team-home-title" className="mt-1 text-2xl font-bold tracking-tight text-surface-100">{t('aiTeamHomeTitle')}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-surface-500">{t('aiTeamHomeDescription')}</p>
            {helper && <button type="button" onClick={() => onNewSession(helper.id)} className="mt-3 text-left text-xs font-semibold text-surface-500 transition-colors hover:text-primary-300">{t('aiTeamHelper')}</button>}
          </div>
          <button type="button" data-tour-id="agent-create" onClick={startCreator} className="ai-team-primary-action w-full shrink-0 rounded-xl px-4 py-3 text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70 sm:w-auto">
            {t('newAiTeammate')}
          </button>
        </div>
        <div className="ai-team-stats mt-5 grid grid-cols-2 border-t sm:grid-cols-4">
          <div className="ai-team-stat"><div className="text-[10px] text-surface-600">{t('aiTeammateCount')}</div><div className="mt-1 text-lg font-bold text-surface-100">{teammates.length}</div></div>
          <div className="ai-team-stat"><div className="text-[10px] text-surface-600">{t('recentActivity')}</div><div className="tone-success tone-text mt-1 text-lg font-bold">{activeCount}</div></div>
          <div className="ai-team-stat"><div className="text-[10px] text-surface-600">{t('totalSessions')}</div><div className="mt-1 text-lg font-bold text-surface-100">{stats.reduce((sum,item)=>sum+item.sessions,0).toLocaleString()}</div></div>
          <div className="ai-team-stat"><div className="text-[10px] text-surface-600">{t('recentTurns')}</div><div className="tone-accent tone-text mt-1 text-lg font-bold">{stats.reduce((sum,item)=>sum+item.turns,0).toLocaleString()}</div></div>
        </div>
      </div>
      <div className="ai-team-people-ops mt-5 rounded-2xl border p-4"><div className="flex items-center justify-between"><div><div className="text-[10px] font-bold uppercase tracking-wider text-surface-600">{t('teamOperations')}</div><h3 className="mt-1 text-sm font-bold text-surface-200">{t('teamStatusNow')}</h3></div></div><div className="mt-3 grid sm:grid-cols-[1fr_1fr_auto]"><div className="ai-team-issue text-xs text-surface-400">{t('careerProgress')} <strong className="float-right text-surface-200">{stats.filter(item=>item.level!=='partner').length}</strong></div><div className="ai-team-issue text-xs text-surface-400">{t('inactive14Days')} <strong className="float-right text-surface-200">{stats.length-activeCount}</strong></div><button onClick={startCreator} className="ai-team-hire-action rounded-lg px-3 py-2.5 text-left text-xs font-bold">{t('createAiTeammate')} →</button></div></div>
      {invited.length>0&&<div className="mt-5"><div className="text-[11px] font-bold text-surface-500">{t('recentlyInvited')}</div><div className="mt-2 flex gap-2 overflow-x-auto pb-1">{[...invited].sort((a,b)=>new Date((b.project as any).invitedAt||0).getTime()-new Date((a.project as any).invitedAt||0).getTime()).slice(0,5).map(item=><button key={item.project.id} onClick={()=>onOpenProjectHome(item.project)} className="flex shrink-0 items-center gap-2 rounded-xl border border-surface-800 bg-surface-900/65 px-3 py-2 text-left"><AgentIdentityAvatar project={item.project} className="h-8 w-8 rounded-lg"/><span><span className="block text-xs font-bold text-surface-200">{item.project.agent?.displayName||item.project.name}</span><span className="text-[10px] text-surface-600">{t('invitedOn', { date: new Date((item.project as any).invitedAt).toLocaleDateString(i18n.language) })}</span></span></button>)}</div></div>}
      <div className="mt-5 flex flex-wrap items-center gap-1.5">{(['all','intern','practitioner','manager','partner'] as const).map(level=><button key={level} onClick={()=>setFilter(level)} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${filter===level?'bg-primary-500/15 text-primary-300':'text-surface-500 hover:bg-surface-800'}`}>{level==='all'?t('all'):levelTitle(level)}</button>)}<select value={sort} onChange={event=>setSort(event.target.value as typeof sort)} className="ml-auto rounded-lg border border-surface-800 bg-surface-900 px-2.5 py-1.5 text-xs text-surface-400" aria-label={t('sortAiTeammates')}><option value="recent">{t('sortRecentWork')}</option><option value="created">{t('sortRecentlyCreated')}</option><option value="name">{t('sortName')}</option></select></div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label={t('aiTeammateList')}>
        {teammates.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-surface-700 p-5 text-center"><div className="text-sm font-semibold text-surface-300">{t('noAiTeammates')}</div><p className="mt-1 text-xs leading-5 text-surface-600">{t('noAiTeammatesDescription')}</p></div>
        ) : filtered.map(({project,sessions:sessionCount,turns,latest,level}) => {
          const recent = latestConversation(project.id, sessions);
          const agent = project.agent;
          const displayName = agent?.displayName?.trim() || project.name;
          const description = agent?.tagline?.trim() || agent?.role?.trim() || project.description?.trim() || t('teammateFallbackDescription', { name: project.name });
          return (
            <article key={project.id} role="link" tabIndex={0} aria-label={t('openTeammateHome', { name: displayName })} onClick={() => onOpenProjectHome(project)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenProjectHome(project); } }} className={`ai-team-member-card flex min-h-56 min-w-0 cursor-pointer flex-col rounded-2xl border p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70 ${recent?.id === activeSessionId ? 'is-active' : ''}`}>
              <div className="flex min-w-0 items-start gap-3">
                <AgentIdentityAvatar project={project} className="h-12 w-12 shrink-0 rounded-xl border border-primary-400/20" />
                <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-bold text-surface-100">{displayName}</h3><p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-surface-500">{description}</p><div className="mt-1 truncate text-[10px] text-surface-650">{t('workspace')} · {project.name} · {levelTitle(level)}</div><div className="mt-3 flex gap-3 text-[11px] text-surface-500"><span>{t('sessionsCount', { count: sessionCount })}</span><span>{t('collaboratorsCount', { count: (project as any).memberCount||1 })}</span></div></div>
              </div>
              <div className="mt-auto pt-4"><div className="grid grid-cols-3 gap-1.5 rounded-xl bg-surface-950/35 p-2 text-center"><div><div className="text-[10px] text-surface-600">{t('careerLevel')}</div><div className="mt-1 text-xs font-bold text-primary-300">{levelTitle(level)}</div></div><div><div className="text-[10px] text-surface-600">{t('recent7Days')}</div><div className="mt-1 text-xs font-bold text-surface-200">{((project as any).recentUsage?.recent7||0).toLocaleString()} turns</div></div><div><div className="text-[10px] text-surface-600">{t('collaborators')}</div><div className="mt-1 text-xs font-bold text-surface-200">{(project as any).memberCount||1}</div></div></div><div className="mt-2"><div className="flex items-center justify-between text-[10px] text-surface-600"><span>{t('recentDailyUsage')}</span><span className={(project as any).recentUsage?.changePercent>=0?'text-emerald-400':'text-rose-400'}>{(project as any).recentUsage?.changePercent==null?t('noPreviousWeekData'):`${(project as any).recentUsage.changePercent>=0?'+':''}${(project as any).recentUsage.changePercent}%`}</span></div><div className="mt-1.5 flex h-5 items-end gap-1" aria-label={t('recentTurnUsage')}>{((project as any).recentUsage?.dailyTurns||Array.from({length:7},(_,index)=>({day:String(index),turns:0}))).map((item:any)=>{const max=Math.max(...((project as any).recentUsage?.dailyTurns||[{turns:0}]).map((row:any)=>row.turns),1);return <span key={item.day} className="flex-1 rounded-t bg-primary-400/45" style={item.turns>0?{height:`${Math.max(12,item.turns/max*100)}%`}:{height:0}} title={`${item.day} · ${item.turns} turns`}/>})}</div></div><div className="mt-2 flex items-center justify-between gap-2"><button type="button" onClick={(event) => { event.stopPropagation(); onOpenProjectHome(project); }} className="tone-accent tone-action rounded-lg border px-3 py-2.5 text-xs font-bold transition-colors">{t('teammateHome')}</button>{recent&&<button type="button" onClick={(event) => { event.stopPropagation(); onSelectSession(recent); }} className="px-2 py-2 text-xs font-semibold text-surface-500 transition-colors hover:text-surface-200">{t('recentConversation')}</button>}</div></div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
