import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SIDEBAR_PATH = path.resolve(import.meta.dirname, './Sidebar.tsx');
const TIMELINE_MODEL_PATH = path.resolve(import.meta.dirname, '../../features/navigation-sidebar/sessions/sidebar-session-timeline-model.ts');
const TIMELINE_VIEW_PATH = path.resolve(import.meta.dirname, '../../features/navigation-sidebar/sessions/SidebarSessionTimeline.tsx');
const AGENT_RAIL_MODEL_PATH = path.resolve(import.meta.dirname, '../../features/navigation-sidebar/sessions/sidebar-agent-rail-model.ts');

describe('Sidebar realtime performance source contracts', () => {
  it('keeps render instrumentation opt-in via localStorage', () => {
    const src = fs.readFileSync(SIDEBAR_PATH, 'utf-8');
    expect(src).toMatch(/tower:perf:sidebar/);
    expect(src).toMatch(/\[perf\]\[Sidebar\]/);
    expect(src).toMatch(/isSidebarPerfEnabled\(\)/);
  });

  it('does not subscribe every ProjectGroup to hot streaming and unread Sets', () => {
    const src = fs.readFileSync(SIDEBAR_PATH, 'utf-8');
    const projectGroup = src.match(/function ProjectGroup\([\s\S]*?\n}\n\nfunction LabelGroup/);
    expect(projectGroup?.[0]).toBeTruthy();
    expect(projectGroup?.[0]).not.toMatch(/useSessionStore\(\(s\) => s\.streamingSessions/);
    expect(projectGroup?.[0]).not.toMatch(/useSessionStore\(\(s\) => s\.unreadSessions/);
    expect(projectGroup?.[0]).toMatch(/hasActivity: boolean/);
    expect(projectGroup?.[0]).toMatch(/myUnreadCount: number/);
  });

  it('persists sidebar scroll outside component state for mobile drawer remounts', () => {
    const src = fs.readFileSync(SIDEBAR_PATH, 'utf-8');
    expect(src).toMatch(/sidebar-scroll:v1/);
    expect(src).toMatch(/function saveSidebarScroll/);
    expect(src).toMatch(/function getStoredSidebarScroll/);
    expect(src).toMatch(/saveSidebarTabScroll\(sidebarTab, container\.scrollTop\)/);
  });

  it('keeps Latest ordered by activity, respects Chat/Agent identity, and ignores attention state', () => {
    const src = fs.readFileSync(SIDEBAR_PATH, 'utf-8');
    const latestQuickSessions = src.match(/const latestQuickSessions = useMemo\(\(\) => \{[\s\S]*?\n  \}, \[[^\n]+\]\);/);
    expect(latestQuickSessions?.[0]).toBeTruthy();
    expect(latestQuickSessions?.[0]).toContain('isLatestSessionDismissed');
    expect(latestQuickSessions?.[0]).toContain("sessionKindFilter === 'agents'");
    expect(latestQuickSessions?.[0]).toContain('getSessionPresentationKind');
    expect(latestQuickSessions?.[0]).toContain('new Date(b.updatedAt)');
    expect(latestQuickSessions?.[0]).not.toContain('isUnread');
    expect(latestQuickSessions?.[0]).not.toContain('isStreaming');
    expect(latestQuickSessions?.[0]).not.toContain('recentlyReadSessionUntil');
  });

  it('shows Work conversations directly in fixed 50-item batches with date groups', () => {
    const src = fs.readFileSync(SIDEBAR_PATH, 'utf-8');
    expect(src).toContain('const LATEST_SESSIONS_DEFAULT_LIMIT = 50');
    expect(src).toContain('const LATEST_SESSIONS_LOAD_BATCH = 50');
    expect(src).toContain('<SidebarSessionTimeline');
    const timelineView = fs.readFileSync(TIMELINE_VIEW_PATH, 'utf-8');
    expect(timelineView).toContain('data-new-date-group={run.dateKey}');
    expect(src).toContain("todayLabel: t('today')");
    expect(src).toContain("yesterdayLabel: t('yesterday')");
    expect(src).toContain('locale: i18n.resolvedLanguage || i18n.language');
    const timelineModel = fs.readFileSync(TIMELINE_MODEL_PATH, 'utf-8');
    expect(timelineModel).toContain('new Intl.DateTimeFormat(input.locale');
    expect(src).not.toContain('LATEST_SESSIONS_COLLAPSED_STORAGE_KEY');
    expect(src).not.toContain('latestSessionsCollapsed');
    expect(src).not.toContain('toggleLatestSessionsCollapsed');
    expect(src).not.toContain("t('keepLatestTen')");
    expect(src).not.toContain("t('clearRecentConversations')");
    expect(src).not.toContain('기본 10개만 보기');
    expect(src).not.toContain('기본 20개만 보기');
    expect(src).toContain('showMoreLatestSessions(latestTotal)');
  });

  it('uses a unified Agent rail and session pane in Agent-first desktop navigation', () => {
    const src = fs.readFileSync(SIDEBAR_PATH, 'utf-8');
    expect(src).toContain("aria-label={t('agentNavigation')}");
    expect(src).not.toContain('sidebar-inbox-button');
    expect(src).toContain('selectedAgentProjectId');
    expect(src).toContain('navigationGroupedSessions');
    expect(src).toContain('const [agentNavScope, setAgentNavScope] = useState<AgentNavScope>');
    expect(src).toContain("aria-label={t('openAiTeamHome')}");
    expect(src).toContain("aria-label={t('openRecentConversations')}");
    expect(src).toContain("title={t('workNavTitle')}");
    expect(src).toContain('M12 7.25V12l3 1.75');
    expect(src).toContain("agentNavScope === 'team'");
    expect(src).toContain("aria-label={t('aiTeamHomeSummary')}");
    expect(src).toContain('/api/work/challenge-timeline?');
    expect(src).toContain('teamRecentWorkstreams.map');
    expect(src).toContain("t('recentWorkDescription')");
    expect(src).not.toContain('고정 대화');
    expect(src).not.toContain('fixedSessions');
    expect(src).not.toContain("selectedAgentProjectId ? t('conversations', { defaultValue: '대화' }) : t('latestSessions')");
    expect(src).not.toContain("{ key: 'pinned', label: 'PIN', title: '고정한 AI'");
    expect(src).not.toContain("{ key: 'newest', label: 'NEW', title: '최근 사용한 AI'");
    expect(src).toContain('sidebar-agent-nav-expanded:v1');
    expect(src).toContain("aria-label={agentNavExpanded ? 'AI 이름 목록 접기' : 'AI 이름 목록 펼치기'}");
    expect(src).toContain('transition-[width] duration-200 ease-out motion-reduce:transition-none');
    expect(src).toContain('scrollbar-none min-h-0 w-40 flex-1 overflow-y-auto');
    expect(src).toContain('<div className="w-40 shrink-0">');
    expect(src).toContain("agentNavExpanded ? 'opacity-100' : 'opacity-0'");
    expect(src).not.toContain("agentNavExpanded && <span className=\"min-w-0 flex-1 truncate text-[13px] font-medium");
    expect(src).toContain('[mask-image:linear-gradient(to_bottom,transparent_0,black_10px');
    expect(src).toContain('scrollbar-none h-full min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden');
    expect(src).toContain("sidebarTab === 'files' ? '' : 'overflow-y-auto'");
    expect(src).toContain("overflowY: sidebarTab === 'files' ? 'hidden' : undefined");
    expect(src).not.toContain('latestSessionsCollapsed');
    expect(src).toContain("title={t('aiTeamNavTitle')}");
    expect(src).toContain("agentNavScope === 'work' && !isSearching");
    expect(src).toContain("setActiveView('aiTeam')");
    expect(src).toContain("rememberAgentWorkspaceLocation(project.id, 'home')");
    expect(src).toContain("aria-label={t('openNamedHome', { name: project.agent?.displayName || project.name })}");
    expect(src).toContain("min-[769px]:hidden");
    expect(src).toContain('latestSessionRuns');
    const timelineView = fs.readFileSync(TIMELINE_VIEW_PATH, 'utf-8');
    expect(timelineView).toContain('data-new-agent-run={run.project.id}');
    expect(timelineView).toContain('run.project.agent?.displayName || run.project.name');
    expect(timelineView).toContain('border-l border-surface-700/35');
    expect(timelineView).not.toContain('AgentIdentityAvatar project={run.project}');
    const timelineModel = fs.readFileSync(TIMELINE_MODEL_PATH, 'utf-8');
    expect(src).toContain('buildSidebarSessionTimelineModel({');
    expect(timelineModel).toContain('if (previous?.key === key && previous.dateKey === dateKey) previous.sessions.push(session)');
    expect(timelineModel).toContain('같은 날짜의 인접한 동일 Project Session만 run으로 묶는다');
    expect(src).toContain('onContextMenu={(event) =>');
    expect(src).toContain('setAgentRailMenu({ x: event.clientX, y: event.clientY, projectId: project.id })');
    expect(src).toContain('<ProjectContextMenu');
    expect(src).toContain('selectedAgentProjectId && filterLabels');
    expect(src).toContain('selectedDeckGroups');
    expect(src).toContain('<LabelGroup');
    expect(src).toContain("rememberAgentWorkspaceLocation(project.id, 'files')");
    expect(src).toContain("aria-label={t('openNamedFiles', { name: project.agent?.displayName || project.name })}");
    expect(src).not.toContain('showPinControls={false}');
    expect(src).toContain('buildSidebarAgentRailModel({ projects, sessions })');
    const agentRailModel = fs.readFileSync(AGENT_RAIL_MODEL_PATH, 'utf-8');
    expect(agentRailModel).toContain('const pinDelta = Number(b.project.pinned) - Number(a.project.pinned)');
    expect(agentRailModel).toContain('const orderDelta = projectPinOrder(a.project) - projectPinOrder(b.project)');
    expect(src).toContain("aria-label={t('openNamedActionsMenu', { name: project.agent?.displayName || project.name })}");
    expect(src).toContain('selectedAgentProjectId && filterLabels ? 0');
    expect(src).toContain('Keep first-level teammate navigation independent from conversation filters');
    expect(src).toContain("{t('uncategorized')}");
    expect(src).toContain('label="temp"');
    expect(src).toContain('key={`${selectedAgentProjectId}:__uncategorized__`}');
    expect(src).toContain('key={`${project.id}:__uncategorized__`}');
    expect(src).toContain('isSystemGroup');
    expect(src).toContain('No-deck sessions stay discoverable in one synthetic Uncategorized group.');
    expect(src).not.toContain('function UnlabeledDropZone');
    expect(src).not.toContain("{t('pins')}\n");
    expect(src).not.toContain("{t('recent')}\n");
  });

  it('creates decks as labels without reusing the deck name as the session title', () => {
    const src = fs.readFileSync(SIDEBAR_PATH, 'utf-8');
    expect(src).toContain('body: JSON.stringify({ projectId, label })');
    expect(src).not.toContain('body: JSON.stringify({ projectId, name: label })');
    expect(src).toContain("t('addDeckButton')");
    expect(src).toContain("'temp': t ? t('defaultDeck') : '기본'");
  });

  it('gives the shared project menu keyboard semantics and focus recovery', () => {
    const src = fs.readFileSync(SIDEBAR_PATH, 'utf-8');
    expect(src).toContain('role="menu" aria-label={t(\'projectActions\')}');
    expect(src).toContain('role="menuitem"');
    expect(src).toContain('role="menuitemradio"');
    expect(src).toContain("['ArrowDown', 'ArrowUp', 'Home', 'End']");
    expect(src).toContain("if (event.key === 'Escape')");
    expect(src).toContain('previousFocusRef.current?.focus()');
  });
});
