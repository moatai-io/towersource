import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const englishLocaleRoot = path.join(path.resolve(import.meta.dirname), 'locales/en');
const englishLocaleDocuments = fs.readdirSync(englishLocaleRoot)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(fs.readFileSync(path.join(englishLocaleRoot, name), 'utf8')));
const collectLocaleValues = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectLocaleValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectLocaleValues);
  return [];
};
const englishLocaleValues = englishLocaleDocuments.flatMap(collectLocaleValues).join('\n');
const englishLayout = JSON.parse(fs.readFileSync(path.join(englishLocaleRoot, 'layout.json'), 'utf8'));

const sourceRoot = path.resolve(import.meta.dirname);
const sessionStore = fs.readFileSync(path.join(sourceRoot, 'stores/session-store.ts'), 'utf8');
const header = fs.readFileSync(path.join(sourceRoot, 'components/layout/Header.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.join(sourceRoot, 'components/layout/Sidebar.tsx'), 'utf8');
const agentRail = fs.readFileSync(path.join(sourceRoot, 'components/layout/AgentNavigationRail.tsx'), 'utf8');
const mobileTabs = fs.readFileSync(path.join(sourceRoot, 'components/layout/MobileTabBar.tsx'), 'utf8');

describe('navigation language contract', () => {
  it('keeps internal state surfaces distinct while presenting them as Sessions', () => {
    expect(sessionStore).toContain("export type MobileTab = 'sessions' | 'ai'");
    expect(sessionStore).toContain("export type SidebarTab = 'sessions' | 'files'");
    expect(sessionStore).toContain("export type ActiveView = 'chat' | 'aiTeam'");
    expect(header).toContain("{ key: 'ai', label: t('conversationsNav'), badge: 0 }");
    expect(header).not.toContain("{ key: 'work'");
    expect(header).toContain("{ key: 'files', label: t('files'), badge: 0 }");
  });

  it('routes Conversations to the Session workspace without restoring a duplicate Work tab', () => {
    const aiStart = header.indexOf("case 'ai':");
    const filesStart = header.indexOf("case 'files':", aiStart);
    const aiBlock = header.slice(aiStart, filesStart);

    expect(aiBlock).toContain('useFileStore.getState().activateChatSlot()');
    expect(aiBlock).toContain('onNavigateSessions?.()');
    expect(aiBlock).toContain('store.setAiNavigationSurface()');
    expect(aiBlock).toContain('store.setSidebarOpen(true)');
    expect(aiBlock).not.toContain("setActiveView('aiTeam')");
    expect(header).not.toContain("case 'work':");
  });

  it('labels the Session sidebar by its actual purpose and separates teammate management', () => {
    expect(agentRail).toContain("title={t('conversationsNavTitle')}");
    expect(agentRail).toContain("{t('recentConversationsNav')}");
    expect(agentRail).toContain("title={t('aiTeammateManagementTitle')}");
    expect(agentRail).toContain("{t('aiTeammateManagement')}");
  });

  it('uses compact English navigation labels and reserves longer copy for titles', () => {
    expect(englishLayout.conversationsNav).toBe('Sessions');
    expect(englishLayout.recentConversationsNav).toBe('Recent sessions');
    expect(englishLayout.aiTeammateManagement).toBe('AI Teams');
    expect(englishLayout.aiTeamQuickPanel.manageAll).toBe('AI Teams');
    expect(englishLayout.conversationsNav.length).toBeLessThanOrEqual(12);
    expect(englishLayout.aiTeammateManagement.length).toBeLessThanOrEqual(12);
    expect(englishLayout.conversationsNavTitle).toContain('Sessions');
    expect(englishLayout.conversationsNavTitle.length).toBeGreaterThan(englishLayout.conversationsNav.length);
  });

  it('keeps mobile top-level navigation aligned with desktop', () => {
    expect(mobileTabs).toContain("{ id: 'ai', label: t('conversationsNav')");
    expect(mobileTabs).not.toContain("{ id: 'work'");
    expect(mobileTabs).toContain("{ id: 'files', label: t('files')");
    expect(mobileTabs).toContain('onNavigateSessions?.()');
    expect(mobileTabs).toContain('setAiNavigationSurface()');
  });
});
