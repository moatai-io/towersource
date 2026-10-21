import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const home = fs.readFileSync(path.resolve(import.meta.dirname, './AITeamHome.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.resolve(import.meta.dirname, '../layout/Sidebar.tsx'), 'utf8');
const header = fs.readFileSync(path.resolve(import.meta.dirname, '../layout/Header.tsx'), 'utf8');

describe('existing-user AI Team home', () => {
  it('keeps the primary AI tab on conversations and the teammate home explicit', () => {
    expect(header).toContain("case 'ai':");
    expect(header).toContain('store.setAiNavigationSurface()');
    expect(header).toContain('store.setSidebarOpen(true)');
    expect(sidebar).not.toContain('<AITeamHome');
  });

  it('renders resilient Project.agent cards with Project fallbacks', () => {
    expect(home).toContain('agent?.displayName?.trim() || project.name');
    expect(home).toContain('project.description?.trim()');
    expect(home).toContain('AgentIdentityAvatar');
    expect(home).toContain("t('aiTeammateManagement')");
    expect(home).not.toContain('Primary AI 팀원');
  });

  it('separates the Tower helper from teammates and opens creation directly', () => {
    expect(home).toContain("project.systemKey === 'ai-talent-team'");
    expect(home).toContain('!project.systemKey');
    expect(home).toContain("new CustomEvent('tower-start-agent-academy')");
    expect(home).toContain("t('aiTeamHelper')");
    expect(home).toContain('onNewSession(helper.id)');
    expect(home).not.toContain('AI 인재팀');
    expect(home).toContain("t('newAiTeammate')");
    expect(home).toContain("{t('workspace')}</dt>");
    expect(header).not.toContain('label={t(\'newProject\')}');
    expect(header).not.toContain('label="새 에이전트"');
  });

  it('includes every active non-system Project in the default Agent directory', () => {
    expect(home).toContain('const teammates = projects.filter((project) => !project.systemKey && !project.archived);');
    expect(home).not.toContain('project.agent?.explicit === true');
    expect(home).toContain("t('legacyTeammate')");
  });

  it('searches legacy and archived Agents outside the default directory', () => {
    expect(home).toContain("const [query, setQuery] = React.useState('')");
    expect(home).toContain("placeholder={t('searchAiTeammates')}");
    expect(home).toContain('/api/projects/search?q=');
    expect(home).toContain('[...projects, ...remoteMatches]');
    expect(home).toContain('.filter((project) => !project.systemKey');
    expect(home).toContain('project.agent?.displayName');
    expect(home).toContain('project.name');
    expect(home).toContain("t('archivedTeammate')");
    expect(home).toContain("t('aiTeammateSearchSummary'");
  });

  it('uses visible sessions for availability and compact counts while offering management and conversation actions', () => {
    expect(home).not.toContain('/api/sessions');
    expect(home).toContain("t('manageTeammate')");
    expect(home).toContain("t('startConversation')");
    expect(home).toContain('onOpenProjectHome(project)');
    expect(home).toContain('onNewSession(project.id)');
  });

  it('uses a quiet teammate directory without a duplicate work dashboard', () => {
    expect(home).toContain('ai-team-control-room');
    expect(home).toContain('ai-team-hero');
    expect(home).toContain('ai-team-member-card');
    expect(home).not.toContain('dailyTurns');
    expect(home).not.toContain('recentUsage');
    expect(home).not.toContain('ai-team-people-ops');
  });

  it('keeps narrow layouts usable without fixed card widths or undersized teammate columns', () => {
    expect(home).toContain('min-w-0');
    expect(home).toContain('w-full');
    expect(home).toContain('grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))]');
    expect(home).not.toContain('2xl:grid-cols-5');
    expect(home).not.toMatch(/w-\[(?:[3-9]\d\d|\d{4,})px\]/);
  });
});
