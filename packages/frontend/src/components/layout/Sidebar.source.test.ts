import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SIDEBAR_PATH = path.resolve(import.meta.dirname, './Sidebar.tsx');
const AGENT_NAV_RAIL_PATH = path.resolve(import.meta.dirname, './AgentNavigationRail.tsx');
const TIMELINE_MODEL_PATH = path.resolve(import.meta.dirname, '../../features/navigation-sidebar/sessions/sidebar-session-timeline-model.ts');
const SESSION_LIST_MODEL_PATH = path.resolve(import.meta.dirname, '../../features/navigation-sidebar/sessions/sidebar-session-list-model.ts');
const TIMELINE_VIEW_PATH = path.resolve(import.meta.dirname, '../../features/navigation-sidebar/sessions/SidebarSessionTimeline.tsx');
const AGENT_RAIL_MODEL_PATH = path.resolve(import.meta.dirname, '../../features/navigation-sidebar/sessions/sidebar-agent-rail-model.ts');
const FILES_TOOLBAR_PATH = path.resolve(import.meta.dirname, './SidebarFilesToolbar.tsx');
const FILES_SURFACE_PATH = path.resolve(import.meta.dirname, './SidebarFilesSurface.tsx');

describe('Sidebar realtime performance source contracts', () => {
  it('loads conditional file and credential surfaces only when their sidebar branch renders', () => {
    const src = fs.readFileSync(SIDEBAR_PATH, 'utf-8');
    for (const target of [
      './AgentCredentialsModal',
      './SidebarFilesSurface',
    ]) {
      expect(src).toContain(`import('${target}')`);
      expect(src).not.toContain(`from '${target}'`);
    }
    expect(src).not.toContain("from './SessionFilesMenuSection'");
    expect(fs.readFileSync(FILES_SURFACE_PATH, 'utf-8')).toContain("import { SessionFilesMenuSection } from './SessionFilesMenuSection'");
    expect(src).toContain('showCredentials');
    expect(src).toContain("sidebarTab === 'files'");
  });

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
    const model = fs.readFileSync(SESSION_LIST_MODEL_PATH, 'utf-8');
    expect(src).toContain('buildSidebarLatestQuickSessions({');
    expect(model).toContain('isLatestSessionDismissed(dismissedKeys, session)');
    expect(model).toContain('matchesSessionListFilters(session, filters, {');
    expect(model).toContain('sidebarSessionTimestampMs(b.updatedAt) - sidebarSessionTimestampMs(a.updatedAt)');
    expect(model).toContain('isSessionParticipatedByCurrentUser(session, currentUsername)');
    expect(src).not.toContain('recentlyReadSessionUntil');
    expect(src).not.toContain('(lastUserUsername || session.ownerUsername) === currentUsername');
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
    const railSrc = fs.readFileSync(AGENT_NAV_RAIL_PATH, 'utf-8');
    const filesToolbarSrc = fs.readFileSync(FILES_TOOLBAR_PATH, 'utf-8');
    const filesSurfaceSrc = fs.readFileSync(FILES_SURFACE_PATH, 'utf-8');
    expect(src).toContain('<AgentNavigationRail');
    expect(railSrc).toContain("aria-label={t('agentNavigation')}");
    expect(src).not.toContain('sidebar-inbox-button');
    expect(src).toContain('selectedAgentProjectId');
    expect(src).toContain("contextualProjectId={agentNavScope === 'work' && selectedAgentProjectId === null ? activeSessionProjectId : null}");
    expect(railSrc).toContain('const contextual = !selected && contextualProjectId === project.id');
    expect(railSrc).toContain("contextual ? 'bg-primary-500/[0.045]'");
    expect(src).toContain('navigationGroupedSessions');
    expect(src).toContain('const [agentNavScope, setAgentNavScope] = useState<AgentNavScope>');
    expect(railSrc).toContain("aria-label={t('openAiTeamHome')}");
    expect(railSrc).toContain("aria-label={t('openRecentConversations')}");
    expect(railSrc).toContain("title={t('conversationsNavTitle')}");
    expect(railSrc).toContain("title={t('aiTeammateManagementTitle')}");
    expect(railSrc).toContain('M12 7.25V12l3 1.75');
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
    expect(railSrc).toContain("aria-label={expanded ? t('collapseAiNameList') : t('expandAiNameList')}");
    expect(railSrc).toContain("isResizing ? 'transition-none' : 'transition-[width,margin-right] duration-200 ease-out'");
    expect(src).toContain('useResizablePane({');
    expect(src).toContain('isResizing: isAgentNavResizing');
    expect(src).toContain('startResize: startAgentNavResize');
    expect(src).toContain('onResize: setAgentNavWidth');
    expect(src).toContain('onResizeEnd: persistAgentNavWidth');
    expect(railSrc).toContain('style={{ width: visuallyExpanded ? width : 56, marginRight: !expanded && hoverExpanded ? -(width - 56) : 0 }}');
    expect(railSrc).toContain('scrollbar-none min-h-0 w-full flex-1 overflow-y-auto');
    expect(railSrc).toContain('<div className="w-full shrink-0">');
    expect(railSrc).toContain("const labelVisibility = visuallyExpanded ? 'opacity-100' : 'opacity-0'");
    expect(railSrc).not.toContain("expanded && <span className=\"min-w-0 flex-1 truncate text-[13px] font-medium");
    expect(railSrc).toContain('[mask-image:linear-gradient(to_bottom,transparent_0,black_10px');
    expect(src).toContain('scrollbar-none h-full min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden');
    expect(src).toContain("sidebarTab === 'files' ? '' : 'overflow-y-auto'");
    expect(src).toContain("overflowY: sidebarTab === 'files' ? 'hidden' : undefined");
    expect(filesSurfaceSrc).toContain('data-sidebar-files-root="true"');
    expect(filesSurfaceSrc).toContain("className={`h-full min-h-0 overflow-hidden ${isMobile ? 'flex flex-col' : 'grid grid-cols-[176px_minmax(0,1fr)]'}`}");
    expect(filesSurfaceSrc).toContain('<div className="flex min-h-0 min-w-0 flex-col overflow-hidden">');
    expect(filesSurfaceSrc).toContain('flex min-h-0 flex-1 flex-col space-y-1 px-2');
    expect(filesSurfaceSrc).toContain('flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden');
    expect(filesSurfaceSrc).toContain('data-sidebar-files-scroll="true" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"');
    expect(filesSurfaceSrc).toContain('mb-1 mt-2 shrink-0 px-2');
    expect(src).not.toContain('<div className="flex-1">\n\n              {/* Shared with me */}');
    expect(src).not.toContain('const [sharedWithMe, setSharedWithMe]');
    expect(src).not.toContain("fetch('/api/shares/with-me'");
    expect(filesToolbarSrc).toContain('data-sidebar-file-toolbar="true"');
    expect(src).toContain('/api/files/search?root=');
    expect(filesToolbarSrc).toContain("placeholder={t('searchAgentFiles')}");
    expect(filesSurfaceSrc).toContain("project={activeFileProject}");
    expect(filesSurfaceSrc).toContain("query={fileSearchQuery}");
    expect(filesToolbarSrc).toContain("t('addFileOrFolder')");
    expect(filesToolbarSrc).toContain("t('fileViewOptions')");
    expect(filesToolbarSrc).toContain('<SelectModeToggle />');
    expect(src).not.toContain('onOpenWorkspace={() =>');
    expect(filesSurfaceSrc).not.toContain("<div className={`min-h-full ${isMobile ? 'flex flex-col' : 'grid h-full min-h-0 grid-cols-[176px_minmax(0,1fr)] overflow-hidden'}`}>" );
    expect(src).not.toContain('latestSessionsCollapsed');
    expect(railSrc).toContain("title={t('aiTeammateManagementTitle')}");
    expect(src).toContain("agentNavScope === 'work' && !isSearching");
    expect(src).toContain("setActiveView('aiTeam')");
    expect(src).toContain("rememberAgentWorkspaceLocation(project.id, 'home')");
    expect(src).toContain("aria-label={t('openNamedHome', { name: project.agent?.displayName || project.name })}");
    expect(src).toContain("min-[769px]:hidden");
    expect(src).not.toContain("t('mobileNavigationTitle')");
    expect(src).toContain('data-mobile-agent-pane="detail"');
    expect(src).toContain("t('backToAiNavigation')");
    expect(src).toMatch(/data-mobile-agent-pane="detail"[\s\S]*?onClick=\{\(\) => setMobileAgentPane\('root'\)\} className="grid h-12 w-12/);
    expect(src).toContain("mobileAgentPane === 'detail') && <SidebarSessionsToolbar");
    expect(src).toContain('latestSessionRuns');
    const timelineView = fs.readFileSync(TIMELINE_VIEW_PATH, 'utf-8');
    expect(timelineView).toContain('data-new-agent-run={run.project.id}');
    expect(timelineView).toContain('run.project.agent?.displayName || run.project.name');
    expect(timelineView).toContain('sidebar-timeline-project');
    expect(timelineView).toContain('border-l border-surface-700/25');
    expect(timelineView).not.toContain('AgentIdentityAvatar project={run.project}');
    const timelineModel = fs.readFileSync(TIMELINE_MODEL_PATH, 'utf-8');
    expect(src).toContain('buildSidebarSessionTimelineModel({');
    expect(timelineModel).toContain('if (previous?.key === key && previous.dateKey === dateKey) previous.sessions.push(session)');
    expect(timelineModel).toContain('같은 날짜의 인접한 동일 Project Session만 run으로 묶는다');
    expect(railSrc).toContain('onContextMenu={(event) => onOpenProjectMenu(event, project.id)}');
    expect(src).toContain('setAgentRailMenu({ x: event.clientX, y: event.clientY, projectId });');
    expect(src).toContain('<ProjectContextMenu');
    expect(src).toContain('selectedAgentProjectId && filterLabels');
    expect(src).toContain('selectedDeckGroups');
    expect(src).toContain('<LabelGroup');
    const selectedAgentHeader = src.slice(src.indexOf('selectedAgentProjectId && navigationGroupedSessions?.groups[0]'), src.indexOf("agentNavScope === 'work' && !isSearching"));
    expect(selectedAgentHeader).not.toContain("rememberAgentWorkspaceLocation(project.id, 'files')");
    expect(selectedAgentHeader).not.toContain("aria-label={t('openNamedFiles'" );
    expect(src).not.toContain('showPinControls={false}');
    expect(src).toContain('buildSidebarAgentRailModel({ projects: allProjects, sessions })');
    const agentRailModel = fs.readFileSync(AGENT_RAIL_MODEL_PATH, 'utf-8');
    expect(agentRailModel).toContain('const pinDelta = Number(b.project.pinned) - Number(a.project.pinned)');
    expect(agentRailModel).toContain('const orderDelta = projectPinOrder(a.project) - projectPinOrder(b.project)');
    expect(src).toContain("aria-label={t('openNamedActionsMenu', { name: project.agent?.displayName || project.name })}");
    expect(src).toContain('selectedAgentProjectId && filterLabels ? 0');
    expect(src).toContain('Keep first-level teammate navigation independent from conversation filters');
    expect(src).toContain("{t('uncategorized')}");
    expect(src).toContain('label="temp"');
    expect(src).toContain("key={`${selectedAgentProjectId}:${label ?? '__uncategorized__'}`}");
    expect(src).toContain('key={`${project.id}:__uncategorized__`}');
    expect(src).toContain('isSystemGroup');
    expect(src).toContain('sortDeckGroupsByLatestActivity(selectedDeckGroups, selectedUnlabeledSessions)');
    expect(src).not.toContain('function UnlabeledDropZone');
    expect(selectedAgentHeader).not.toContain("{t('pins')}\n");
    expect(selectedAgentHeader).not.toContain("{t('recent')}\n");
  });

  it('sorts the synthetic default deck together with named decks by latest activity', () => {
    const src = fs.readFileSync(SIDEBAR_PATH, 'utf-8');
    const sorter = src.match(/function sortDeckGroupsByLatestActivity[\s\S]*?\n}/)?.[0] || '';
    expect(sorter).toContain('groups.push({ label: null');
    expect(sorter).toContain('groups.sort((a, b) => b.latestActivity - a.latestActivity');
    expect(src).toContain('sortDeckGroupsByLatestActivity(labelGroups, unlabeled)');
    expect(src).not.toContain('{sortedLabels.map');
  });

  it('creates decks as labels without reusing the deck name as the session title', () => {
    const src = fs.readFileSync(SIDEBAR_PATH, 'utf-8');
    expect(src).toContain('body: JSON.stringify({ projectId, label })');
    expect(src).not.toContain('body: JSON.stringify({ projectId, name: label })');
    expect(src).toContain("t('addDeckButton')");
    expect(src).toContain("'temp': t ? t('defaultDeck') : 'Default'");
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
