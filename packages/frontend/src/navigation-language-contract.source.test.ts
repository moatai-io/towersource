import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(import.meta.dirname);
const sessionStore = fs.readFileSync(path.join(sourceRoot, 'stores/session-store.ts'), 'utf8');
const header = fs.readFileSync(path.join(sourceRoot, 'components/layout/Header.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.join(sourceRoot, 'components/layout/Sidebar.tsx'), 'utf8');
const mobileTabs = fs.readFileSync(path.join(sourceRoot, 'components/layout/MobileTabBar.tsx'), 'utf8');

describe('navigation language contract', () => {
  it('keeps internal state surfaces distinct while presenting Session as Conversations', () => {
    expect(sessionStore).toContain("export type MobileTab = 'sessions' | 'ai'");
    expect(sessionStore).toContain("export type SidebarTab = 'sessions' | 'files'");
    expect(sessionStore).toContain("export type ActiveView = 'chat' | 'aiTeam'");
    expect(header).toContain("{ key: 'ai', label: t('conversationsNav'), badge: 0 }");
    expect(header).toContain("{ key: 'work', label: t('workHubNav'), badge: workAttentionCount }");
    expect(header).toContain("{ key: 'files', label: t('files'), badge: 0 }");
  });

  it('routes Conversations to the Session workspace and Work to the work hub', () => {
    const aiStart = header.indexOf("case 'ai':");
    const workStart = header.indexOf("case 'work':", aiStart);
    const filesStart = header.indexOf("case 'files':", workStart);
    const aiBlock = header.slice(aiStart, workStart);
    const workBlock = header.slice(workStart, filesStart);

    expect(aiBlock).toContain('store.setAiNavigationSurface()');
    expect(aiBlock).toContain('store.setSidebarOpen(true)');
    expect(aiBlock).not.toContain("setActiveView('aiTeam')");
    expect(workBlock).toContain("setActiveView('work')");
    expect(workBlock).toContain('store.setSidebarOpen(false)');
  });

  it('labels the Conversation sidebar by its actual purpose and separates teammate management', () => {
    expect(sidebar).toContain("title={t('conversationsNavTitle')}");
    expect(sidebar).toContain("{t('recentConversationsNav')}");
    expect(sidebar).toContain("title={t('aiTeammateManagementTitle')}");
    expect(sidebar).toContain("{t('aiTeammateManagement')}");
  });

  it('keeps mobile top-level navigation aligned with desktop', () => {
    expect(mobileTabs).toContain("{ id: 'ai', label: t('conversationsNav')");
    expect(mobileTabs).toContain("{ id: 'work', label: t('workHubNav')");
    expect(mobileTabs).toContain("{ id: 'files', label: t('files')");
    expect(mobileTabs).toContain('setAiNavigationSurface()');
    expect(mobileTabs).toContain("setActiveView('work')");
  });
});
