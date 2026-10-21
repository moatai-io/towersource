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

  it('keeps Conversations, Agent-scoped documents, and Settings as primary destinations', () => {
    const agentFirstTabs = tabs.slice(tabs.indexOf('const tabs:'), tabs.indexOf('const visibleTabs = tabs;'));
    expect(agentFirstTabs).toContain("{ id: 'ai', label: t('conversationsNav')");
    expect(agentFirstTabs).toContain("{ id: 'files', label: t('files')");
    expect(agentFirstTabs).not.toContain("{ id: 'channel'");
    expect(agentFirstTabs).not.toContain("{ id: 'work'");
    expect(tabs).not.toContain('tower-open-ai-navigation-root');
    expect(tabs).not.toContain("label: '내 업무'");
    expect(tabs).not.toContain("label: '자동화'");
    expect(tabs).not.toContain("setActiveView('work')");
    expect(agentFirstTabs).toContain("{ id: 'settings', label: t('settings')");
    expect(tabs).not.toContain('pendingApprovalCount');
    expect(tabs).toContain("const selectedProjectId = activeSessionProjectId || capabilityProjectId");
    expect(tabs).toContain("projects.find((project) => project.rootPath && !project.archived)");
    expect(tabs).toContain('setMobileFilesNavigationSurface()');
    expect(tabs).not.toContain("setSidebarTab('files')");
    expect(tabs).not.toContain("setActiveView('chat')");
    expect(tabs).toContain('Commit the Files route atomically');
    expect(tabs).toContain('safe-area-inset-bottom');
  });

  it('returns from Agent Home to the active conversation when Conversations is tapped', () => {
    const aiBranch = tabs.slice(tabs.indexOf("if (tab === 'ai')"), tabs.indexOf("} else if (tab === 'files')"));
    expect(aiBranch).toContain('useFileStore.getState().activateChatSlot()');
    expect(aiBranch).toContain('setAiNavigationSurface()');
    expect(aiBranch).toContain('setSidebarOpen(true)');
  });

  it('keeps the AI Team mobile drawer for teammate selection and creation', () => {
    const mobileRoot = sidebar.slice(sidebar.indexOf('data-mobile-agent-pane="root"'), sidebar.indexOf('chooseAiTeammate'));
    expect(mobileRoot).toContain("t('aiTeammateManagement')");
    expect(mobileRoot).toContain("t('recentConversationsNav')");
    expect(mobileRoot).toContain("t('mobileNewDescription')");
    expect(sidebar).not.toContain('tower-open-ai-navigation-root');
    expect(sidebar).toContain('lastMobileAgentNavigation');
    expect(sidebar).toContain("useState<MobileAgentPane>(() => lastMobileAgentNavigation.pane)");
  });

  it('uses compact mobile-first spacing and one bounded Agent Home scroll surface', () => {
    expect(home).toContain('agent-home-profile-actions grid w-full grid-cols-1');
    expect(home).toContain('h-16 w-16');
    expect(project).toContain('safe-area-inset-bottom');
    expect(project).toContain('flex h-full min-h-0 flex-col overflow-hidden');
    expect(project).toContain('min-h-0 flex-1 overflow-y-auto overscroll-contain');
    expect(project).not.toContain('h-[calc(100vh-58px)]');
  });
});
