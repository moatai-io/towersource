import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const FILE_TAB_BAR_PATH = path.resolve(import.meta.dirname, './FileTabBar.tsx');
const MAIN_TAB_PATH = path.resolve(import.meta.dirname, './MainTab.tsx');
const INDEX_CSS_PATH = path.resolve(import.meta.dirname, '../../index.css');

describe('FileTabBar source contracts', () => {
  it('reveals chat tabs using the project store collapsed-state API', () => {
    const src = fs.readFileSync(FILE_TAB_BAR_PATH, 'utf-8');
    const revealChatBlock = src.match(/if \(target\.kind === 'chat'\) \{[\s\S]*?\} else if \(target\.kind === 'file'\)/);
    expect(revealChatBlock?.[0]).toBeTruthy();
    expect(revealChatBlock?.[0]).toMatch(/projectStore\.isProjectCollapsed\(session\.projectId\)/);
    expect(revealChatBlock?.[0]).not.toMatch(/projectStore\.collapsedProjects\.has\(session\.projectId\)/);
  });

  it('shows a readable live teammate name for Project Home tabs', () => {
    const src = fs.readFileSync(FILE_TAB_BAR_PATH, 'utf-8');
    expect(src).toContain("const projectHome = s.kind === 'projectFiles' && s.refId ? projects.find((project) => project.id === s.refId) : null");
    expect(src).toContain("s.kind === 'projectFiles' && s.title === '프로젝트 홈'");
    expect(src).toContain("? t('workspaceFiles')");
    expect(src).toContain("const systemTabAccessibleTitle = projectHome ? `${systemTabTitle} · ${t('teammateHome')}` : systemTabTitle");
    expect(src).toContain('title={systemTabAccessibleTitle}');
    expect(src).toContain('<AgentIdentityAvatar project={projectHome}');
    expect(src).toContain('tone-accent tone-pill');
    expect(src).toContain('<span className="tower-main-tab-title min-w-0 flex-1 overflow-hidden whitespace-nowrap font-normal">{systemTabTitle}</span>');
    expect(src).toContain("{t('teammateHome')}</span>");
    expect(src).toContain('>{systemTabTitle}</span>');
  });

  it('reveals a file in the owning project sidebar without opening teammate home', () => {
    const src = fs.readFileSync(FILE_TAB_BAR_PATH, 'utf-8');
    const revealFileBlock = src.match(/\} else if \(target\.kind === 'file'\) \{[\s\S]*?\n    \}\n\n    sessionStore\.setSidebarOpen\(true\)/);
    expect(revealFileBlock?.[0]).toBeTruthy();
    expect(revealFileBlock?.[0]).toMatch(/findOwningProjectForPath\(useProjectStore\.getState\(\)\.projects, target\.path\)/);
    expect(revealFileBlock?.[0]).toMatch(/setSidebarTab\('files'\)/);
    expect(revealFileBlock?.[0]).toMatch(/setCapabilityProjectId\(project\.id\)/);
    expect(revealFileBlock?.[0]).toMatch(/addExpandedPath/);
    expect(revealFileBlock?.[0]).toMatch(/data-sidebar-file-path/);
    expect(revealFileBlock?.[0]).not.toMatch(/openSystemTab\('projectFiles'|tower-reveal-file-in-agent-home/);
    expect(src).toContain("{t('goToFolder')}");
  });

  it('keeps bounded DOM retries for sidebar reveal, including files loading asynchronously', () => {
    const src = fs.readFileSync(FILE_TAB_BAR_PATH, 'utf-8');
    expect(src).toMatch(/target\.kind === 'file' && attempts % 10 === 0/);
    expect(src).toMatch(/if \(attempts < 60\) window\.setTimeout\(tryReveal, 100\)/);
    expect(src).not.toMatch(/attempts < 90/);
  });

  it('memoizes SessionInfoDialog model list so opening session info does not refetch in a render loop', () => {
    const src = fs.readFileSync(FILE_TAB_BAR_PATH, 'utf-8');
    expect(src).toMatch(/const availableModels = useModelStore\(\(s\) => s\.availableModels\)/);
    expect(src).toMatch(/const allModels = useMemo\([\s\S]*?\[\.\.\.availableModels, \.\.\.piModels, \.\.\.localModels\][\s\S]*?\[availableModels, piModels, localModels\]/);
    expect(src).not.toMatch(/useModelStore\(\(s\) => \[\.\.\.s\.availableModels, \.\.\.s\.piModels, \.\.\.s\.localModels\]\)/);
  });

  it('keeps file pane movement in the context menu instead of inline tab arrows', () => {
    const src = fs.readFileSync(FILE_TAB_BAR_PATH, 'utf-8');
    expect(src).toContain("title={t('fileTabHint', { path: tab.path })}");
    expect(src).toContain("{t('moveToMainTab')}");
    expect(src).toContain("{t('viewInViewer')}");
    expect(src).not.toContain('onMoveToMain');
    expect(src).not.toContain('onMoveToExtraRight');
    expect(src).not.toContain('aria-label="탭을 메인으로 이동"');
    expect(src).not.toContain('aria-label="탭을 Viewer에서 보기"');
  });

  it('exposes pin controls without removing the existing double-click shortcut', () => {
    const src = fs.readFileSync(FILE_TAB_BAR_PATH, 'utf-8');
    const mainTabSrc = fs.readFileSync(MAIN_TAB_PATH, 'utf-8');
    expect(mainTabSrc).toContain('export function MainTabPinButton');
    expect(mainTabSrc).toContain('aria-pressed={pinned}');
    expect(mainTabSrc).toContain('onDoubleClick={(event) =>');
    expect(src).toContain('<MainTabPinButton pinned={pinned}');
    expect(src).toContain('<MainTabPinButton pinned={tab.pinned}');
    expect(src).toContain('<MainTabPinButton pinned={s.pinned}');
  });

  it('keeps chat tab titles bounded while hover actions stay inside the adaptive tab', () => {
    const src = fs.readFileSync(FILE_TAB_BAR_PATH, 'utf-8');
    expect(src).toContain("tower-main-tab-title min-w-0 flex-1 overflow-hidden whitespace-nowrap ${isActive ? 'font-semibold text-gray-100' : 'font-medium'}");
    expect(src).not.toContain("min-w-0 flex-1 truncate ${isActive ? 'font-semibold text-gray-100' : 'font-medium'}");
    const mainTabSrc = fs.readFileSync(MAIN_TAB_PATH, 'utf-8');
    expect(mainTabSrc).toContain('pointer-events-none absolute inset-y-0 right-0');
    expect(src).not.toContain('bg-gradient-to-l from-surface-800');
    expect(src).not.toContain('flex-[0_1_auto] truncate');
  });

  it('progressively hides tab chrome before sacrificing the title at narrow widths', () => {
    const src = fs.readFileSync(FILE_TAB_BAR_PATH, 'utf-8');
    const mainTabSrc = fs.readFileSync(MAIN_TAB_PATH, 'utf-8');
    const css = fs.readFileSync(INDEX_CSS_PATH, 'utf-8');
    expect(src).toContain('tower-main-tab-shell min-w-[4.5rem]');
    expect(src).toContain('tower-main-tab-avatar');
    expect(src).toContain('tower-main-tab-leading');
    expect(mainTabSrc).toContain("data-active={active ? 'true' : 'false'}");
    expect(mainTabSrc).toContain("data-mobile={isMobile ? 'true' : 'false'}");
    expect(mainTabSrc).toContain('tower-main-tab-pin');
    expect(mainTabSrc).toContain('tower-main-tab-close');
    expect(css).toContain('container-type: inline-size');
    expect(css).toContain('@container tower-main-tab (max-width: 9rem)');
    expect(css).toContain('@container tower-main-tab (max-width: 7rem)');
    expect(css).toContain(".tower-main-tab[data-mobile='false'] .tower-main-tab-avatar,");
    expect(css).toContain(".tower-main-tab[data-mobile='false'] .tower-main-tab-leading,");
    expect(src).toContain('tower-main-tab-actions flex shrink-0 items-center');
    expect(css).toContain(".tower-main-tab[data-mobile='false'] .tower-main-tab-title");
    expect(css).toContain('mask-image: linear-gradient(to right');
    expect(css).toContain(".tower-main-tab[data-mobile='false'] .tower-main-tab-actions");
    expect(css).toContain(".tower-main-tab[data-mobile='false']:hover .tower-main-tab-actions");
    expect(css).toContain(".tower-main-tab[data-mobile='false']:focus-within .tower-main-tab-actions");
    expect(css).toContain(".tower-main-tab[data-mobile='false'][data-active='true']");
  });

  it('tracks the actually foreground ChatPanel instead of relying on activeSessionId alone', () => {
    const src = fs.readFileSync(FILE_TAB_BAR_PATH, 'utf-8');
    expect(src).toContain('setVisibleChatSessionId(');
    expect(src).toContain("activeMainKind === 'chat' && activeView === 'chat' ? activeSessionId : null");
    expect(src).toContain('visibleChatSessionId !== sessionId');
    expect(src).toContain("document.visibilityState !== 'visible'");
    expect(src).toContain('!document.hasFocus()');
  });

  it('shows awaiting_user as a first-class question state instead of running or done', () => {
    const src = fs.readFileSync(FILE_TAB_BAR_PATH, 'utf-8');
    expect(src).toContain('const activity = deriveSessionRowActivity({');
    expect(src).toContain('const rowState = deriveSessionRowState(activity, isUnreadAttention);');
    expect(src).toContain('dataRunState={rowState.indicator.kind}');
    expect(fs.readFileSync(MAIN_TAB_PATH, 'utf-8')).toContain('data-run-state={dataRunState}');
    expect(src).toContain("rowState.indicator.kind === 'awaiting_user'");
    expect(src).toContain("title={t('aiNeedsReply')}");
    expect(src).not.toContain('WORKING_PHASES');
  });
});
