import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(import.meta.dirname);
const sessionStore = fs.readFileSync(path.join(sourceRoot, 'stores/session-store.ts'), 'utf8');
const header = fs.readFileSync(path.join(sourceRoot, 'components/layout/Header.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.join(sourceRoot, 'components/layout/Sidebar.tsx'), 'utf8');
const mobileTabs = fs.readFileSync(path.join(sourceRoot, 'components/layout/MobileTabBar.tsx'), 'utf8');

describe('navigation language contract', () => {
  it('keeps product terms mapped to distinct state surfaces', () => {
    expect(sessionStore).toContain("export type MobileTab = 'sessions' | 'ai'");
    expect(sessionStore).toContain("export type SidebarTab = 'sessions' | 'files'");
    expect(sessionStore).toContain("export type ActiveView = 'chat' | 'aiTeam'");
    expect(sessionStore).toContain('`sessions` is the AI navigation surface');
    expect(sessionStore).toContain('`aiTeam` is only the full AI Team home/directory surface');
    expect(sessionStore).toContain('`work` is the full Work history surface');
  });

  it('routes the Top navigation AI tab to the conversation workspace, not full AI Team home', () => {
    const start = header.indexOf("case 'ai':");
    const end = header.indexOf("case 'files':", start);
    const block = header.slice(start, end);
    expect(block).toContain('store.setAiNavigationSurface()');
    expect(block).toContain('store.setSidebarOpen(true)');
    expect(block).not.toContain("setActiveView('aiTeam')");
    expect(header).not.toContain("case 'work':");
  });

  it('keeps Work before AI Team only inside AI navigation', () => {
    expect(sidebar.indexOf("title={t('workNavTitle')}")).toBeGreaterThan(-1);
    expect(sidebar.indexOf("title={t('aiTeamNavTitle')}")).toBeGreaterThan(-1);
    expect(sidebar.indexOf("title={t('workNavTitle')}")).toBeLessThan(sidebar.indexOf("title={t('aiTeamNavTitle')}"));
    expect(header).not.toContain("{ key: 'work'");
  });

  it('keeps mobile bottom AI as the AI tab while drawer scope carries Work-first navigation', () => {
    expect(mobileTabs).toContain("{ id: 'ai', label: t('aiTeamNav')");
    expect(mobileTabs).not.toContain("{ id: 'work'");
    expect(mobileTabs).toContain('setAiNavigationSurface()');
  });
});
