import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const sidebar = fs.readFileSync(path.resolve(import.meta.dirname, './Sidebar.tsx'), 'utf8');
const tabs = fs.readFileSync(path.resolve(import.meta.dirname, './MobileTabBar.tsx'), 'utf8');
const home = fs.readFileSync(path.resolve(import.meta.dirname, '../agents/AgentHomeOverview.tsx'), 'utf8');
const project = fs.readFileSync(path.resolve(import.meta.dirname, '../files/ProjectHome.tsx'), 'utf8');

describe('mobile teammate workspace', () => {
  it('closes the mobile sidebar after opening a teammate home', () => {
    expect(sidebar).toContain("openSystemTab('projectFiles'");
    expect(sidebar).toContain('setSidebarOpen(false)');
  });

  it('keeps AI Team and Agent-scoped documents as primary destinations without a Work bottom tab', () => {
    const agentFirstTabs = tabs.slice(tabs.indexOf('const tabs:'), tabs.indexOf('const visibleTabs = tabs;'));
    expect(agentFirstTabs).toContain("{ id: 'ai', label: t('aiTeamNav')");
    expect(agentFirstTabs).toContain("{ id: 'files', label: t('files')");
    expect(agentFirstTabs).not.toContain("{ id: 'channel'");
    expect(agentFirstTabs).not.toContain("{ id: 'work'");
    expect(tabs).not.toContain('tower-open-ai-navigation-root');
    expect(tabs).not.toContain("label: '내 업무'");
    expect(tabs).not.toContain("label: '자동화'");
    expect(tabs).not.toContain("setActiveView('work')");
    expect(tabs).not.toContain('pendingApprovalCount');
    expect(tabs).toContain("const selectedProjectId = activeSessionProjectId || capabilityProjectId");
    expect(tabs).toContain("projects.find((project) => project.rootPath && !project.archived)");
    expect(tabs).toContain('setMobileFilesNavigationSurface()');
    expect(tabs).not.toContain("setSidebarTab('files')");
    expect(tabs).not.toContain("setActiveView('chat')");
    expect(tabs).toContain('Commit the Files route atomically');
    expect(tabs).toContain('safe-area-inset-bottom');
  });

  it('keeps the AI Team mobile drawer for teammate selection and creation', () => {
    const mobileRoot = sidebar.slice(sidebar.indexOf('data-mobile-agent-pane="root"'), sidebar.indexOf('chooseAiTeammate'));
    expect(mobileRoot).toContain("t('aiTeamNav')");
    expect(mobileRoot).toContain("t('workNav')");
    expect(mobileRoot.indexOf("t('workNav')")).toBeLessThan(mobileRoot.indexOf("t('aiTeamNav')"));
    expect(mobileRoot).toContain("t('mobileNewDescription')");
    expect(sidebar).not.toContain('tower-open-ai-navigation-root');
    expect(sidebar).toContain('lastMobileAgentNavigation');
    expect(sidebar).toContain("useState<MobileAgentPane>(() => lastMobileAgentNavigation.pane)");
  });

  it('uses compact mobile-first spacing and safe-area room', () => {
    expect(home).toContain('grid w-full grid-cols-3');
    expect(home).toContain('h-16 w-16');
    expect(project).toContain('safe-area-inset-bottom');
  });
});
