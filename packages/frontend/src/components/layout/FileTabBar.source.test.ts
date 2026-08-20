import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const FILE_TAB_BAR_PATH = path.resolve(import.meta.dirname, './FileTabBar.tsx');

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
    expect(src).toContain("s.pinned ? 'font-normal' : 'italic'");
    expect(src).toContain("{t('teammateHome')}</span>");
    expect(src).toContain('>{systemTabTitle}</span>');
  });

  it('reveals a file in the owning project sidebar without opening teammate home', () => {
    const src = fs.readFileSync(FILE_TAB_BAR_PATH, 'utf-8');
    const revealFileBlock = src.match(/\} else if \(target\.kind === 'file'\) \{[\s\S]*?\n    \}\n\n    sessionStore\.setSidebarOpen\(true\)/);
    expect(revealFileBlock?.[0]).toBeTruthy();
    expect(revealFileBlock?.[0]).toMatch(/findOwningProjectForPath\(projects, target\.path\)/);
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

  it('keeps chat tab titles bounded while hover actions stay inside the adaptive tab', () => {
    const src = fs.readFileSync(FILE_TAB_BAR_PATH, 'utf-8');
    expect(src).toContain("min-w-0 flex-1 truncate ${pinned?'not-italic':'italic'}");
    expect(src).toContain('pointer-events-none absolute inset-y-0 right-0');
    expect(src).not.toContain('flex-[0_1_auto] truncate');
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
    expect(src).toContain('data-run-state={rowState.indicator.kind}');
    expect(src).toContain("rowState.indicator.kind === 'awaiting_user'");
    expect(src).toContain("title={t('aiNeedsReply')}");
    expect(src).not.toContain('WORKING_PHASES');
  });
});
