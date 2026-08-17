import React from 'react';
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
  const filtered=[...filteredBase].sort((a,b)=>sort==='name'?(a.project.agent?.displayName||a.project.name).localeCompare(b.project.agent?.displayName||b.project.name,'ko'):sort==='created'?new Date(b.project.createdAt||0).getTime()-new Date(a.project.createdAt||0).getTime():new Date((b.project as any).lastWorkedAt||0).getTime()-new Date((a.project as any).lastWorkedAt||0).getTime());
  const invited=filtered.filter(item=>(item.project as any).invitedByOther===true);
  const levelTitle=(level:AgentCareerLevel)=>level==='intern'?'인턴':level==='practitioner'?'실무자':level==='manager'?'매니저':'파트너';

  return (
    <section ref={rootRef} aria-labelledby="ai-team-home-title" className="ai-team-control-room agent-product-surface min-w-0 pb-8 [word-break:keep-all] [overflow-wrap:break-word]">
      <div className="ai-team-hero overflow-hidden rounded-3xl border p-5 sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="tone-accent tone-text text-[10px] font-bold uppercase tracking-[0.18em]">AI Team</div>
            <h2 id="ai-team-home-title" className="mt-1 text-2xl font-bold tracking-tight text-surface-100">함께 일하는 AI 팀원</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-surface-500">역할과 맥락을 가진 팀원을 고르고, 지금 맡긴 일과 최근 결과를 확인합니다.</p>
            {helper && <button type="button" onClick={() => onNewSession(helper.id)} className="mt-3 text-left text-xs font-semibold text-surface-500 transition-colors hover:text-primary-300">Tower 사용·자동화 상담하기 →</button>}
          </div>
          <button type="button" data-tour-id="agent-create" onClick={startCreator} className="ai-team-primary-action w-full shrink-0 rounded-xl px-4 py-3 text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70 sm:w-auto">
            새 AI 팀원
          </button>
        </div>
        <div className="ai-team-stats mt-5 grid grid-cols-2 border-t sm:grid-cols-4">
          <div className="ai-team-stat"><div className="text-[10px] text-surface-600">AI 팀원</div><div className="mt-1 text-lg font-bold text-surface-100">{teammates.length}</div></div>
          <div className="ai-team-stat"><div className="text-[10px] text-surface-600">최근 활동</div><div className="tone-success tone-text mt-1 text-lg font-bold">{activeCount}</div></div>
          <div className="ai-team-stat"><div className="text-[10px] text-surface-600">전체 세션</div><div className="mt-1 text-lg font-bold text-surface-100">{stats.reduce((sum,item)=>sum+item.sessions,0).toLocaleString()}</div></div>
          <div className="ai-team-stat"><div className="text-[10px] text-surface-600">최근 7일 turns</div><div className="tone-accent tone-text mt-1 text-lg font-bold">{stats.reduce((sum,item)=>sum+item.turns,0).toLocaleString()}</div></div>
        </div>
      </div>
      <div className="ai-team-people-ops mt-5 rounded-2xl border p-4"><div className="flex items-center justify-between"><div><div className="text-[10px] font-bold uppercase tracking-wider text-surface-600">AI 팀 운영</div><h3 className="mt-1 text-sm font-bold text-surface-200">지금 확인할 팀 상태</h3></div></div><div className="mt-3 grid sm:grid-cols-[1fr_1fr_auto]"><div className="ai-team-issue text-xs text-surface-400">다음 직급 진행 중 <strong className="float-right text-surface-200">{stats.filter(item=>item.level!=='partner').length}</strong></div><div className="ai-team-issue text-xs text-surface-400">14일 미사용 <strong className="float-right text-surface-200">{stats.length-activeCount}</strong></div><button onClick={startCreator} className="ai-team-hire-action rounded-lg px-3 py-2.5 text-left text-xs font-bold">새 AI 팀원 만들기 →</button></div></div>
      {invited.length>0&&<div className="mt-5"><div className="text-[11px] font-bold text-surface-500">최근 초대받은 AI 팀원</div><div className="mt-2 flex gap-2 overflow-x-auto pb-1">{[...invited].sort((a,b)=>new Date((b.project as any).invitedAt||0).getTime()-new Date((a.project as any).invitedAt||0).getTime()).slice(0,5).map(item=><button key={item.project.id} onClick={()=>onOpenProjectHome(item.project)} className="flex shrink-0 items-center gap-2 rounded-xl border border-surface-800 bg-surface-900/65 px-3 py-2 text-left"><AgentIdentityAvatar project={item.project} className="h-8 w-8 rounded-lg"/><span><span className="block text-xs font-bold text-surface-200">{item.project.agent?.displayName||item.project.name}</span><span className="text-[10px] text-surface-600">{new Date((item.project as any).invitedAt).toLocaleDateString('ko-KR')} 초대</span></span></button>)}</div></div>}
      <div className="mt-5 flex flex-wrap items-center gap-1.5">{(['all','intern','practitioner','manager','partner'] as const).map(level=><button key={level} onClick={()=>setFilter(level)} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${filter===level?'bg-primary-500/15 text-primary-300':'text-surface-500 hover:bg-surface-800'}`}>{level==='all'?'전체':levelTitle(level)}</button>)}<select value={sort} onChange={event=>setSort(event.target.value as typeof sort)} className="ml-auto rounded-lg border border-surface-800 bg-surface-900 px-2.5 py-1.5 text-xs text-surface-400" aria-label="AI 팀원 정렬"><option value="recent">최근 작업 순</option><option value="created">최근 생성 순</option><option value="name">이름 순</option></select></div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="AI 팀원 목록">
        {teammates.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-surface-700 p-5 text-center"><div className="text-sm font-semibold text-surface-300">아직 AI 팀원이 없습니다</div><p className="mt-1 text-xs leading-5 text-surface-600">새 AI 팀원을 만들고 첫 업무부터 함께 시작해 보세요.</p></div>
        ) : filtered.map(({project,sessions:sessionCount,turns,latest,level}) => {
          const recent = latestConversation(project.id, sessions);
          const agent = project.agent;
          const displayName = agent?.displayName?.trim() || project.name;
          const description = agent?.tagline?.trim() || agent?.role?.trim() || project.description?.trim() || `${project.name} 업무를 함께 이어갑니다.`;
          return (
            <article key={project.id} role="link" tabIndex={0} aria-label={`${displayName} AI 팀원 홈 열기`} onClick={() => onOpenProjectHome(project)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenProjectHome(project); } }} className={`ai-team-member-card flex min-h-56 min-w-0 cursor-pointer flex-col rounded-2xl border p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70 ${recent?.id === activeSessionId ? 'is-active' : ''}`}>
              <div className="flex min-w-0 items-start gap-3">
                <AgentIdentityAvatar project={project} className="h-12 w-12 shrink-0 rounded-xl border border-primary-400/20" />
                <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-bold text-surface-100">{displayName}</h3><p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-surface-500">{description}</p><div className="mt-1 truncate text-[10px] text-surface-650">작업 공간 · {project.name} · {levelTitle(level)}</div><div className="mt-3 flex gap-3 text-[11px] text-surface-500"><span>세션 {sessionCount}</span><span>협업 멤버 {(project as any).memberCount||1}명</span></div></div>
              </div>
              <div className="mt-auto pt-4"><div className="grid grid-cols-3 gap-1.5 rounded-xl bg-surface-950/35 p-2 text-center"><div><div className="text-[10px] text-surface-600">직급</div><div className="mt-1 text-xs font-bold text-primary-300">{levelTitle(level)}</div></div><div><div className="text-[10px] text-surface-600">최근 7일</div><div className="mt-1 text-xs font-bold text-surface-200">{((project as any).recentUsage?.recent7||0).toLocaleString()} turns</div></div><div><div className="text-[10px] text-surface-600">협업 멤버</div><div className="mt-1 text-xs font-bold text-surface-200">{(project as any).memberCount||1}명</div></div></div><div className="mt-2"><div className="flex items-center justify-between text-[10px] text-surface-600"><span>최근 일간 사용량</span><span className={(project as any).recentUsage?.changePercent>=0?'text-emerald-400':'text-rose-400'}>{(project as any).recentUsage?.changePercent==null?'전주 데이터 없음':`${(project as any).recentUsage.changePercent>=0?'+':''}${(project as any).recentUsage.changePercent}%`}</span></div><div className="mt-1.5 flex h-5 items-end gap-1" aria-label="최근 7일 turn 사용량">{((project as any).recentUsage?.dailyTurns||Array.from({length:7},(_,index)=>({day:String(index),turns:0}))).map((item:any)=>{const max=Math.max(...((project as any).recentUsage?.dailyTurns||[{turns:0}]).map((row:any)=>row.turns),1);return <span key={item.day} className="flex-1 rounded-t bg-primary-400/45" style={item.turns>0?{height:`${Math.max(12,item.turns/max*100)}%`}:{height:0}} title={`${item.day} · ${item.turns} turns`}/>})}</div></div><div className="mt-2 flex items-center justify-between gap-2"><button type="button" onClick={(event) => { event.stopPropagation(); onOpenProjectHome(project); }} className="tone-accent tone-action rounded-lg border px-3 py-2.5 text-xs font-bold transition-colors">팀원 홈</button>{recent&&<button type="button" onClick={(event) => { event.stopPropagation(); onSelectSession(recent); }} className="px-2 py-2 text-xs font-semibold text-surface-500 transition-colors hover:text-surface-200">최근 대화</button>}</div></div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
