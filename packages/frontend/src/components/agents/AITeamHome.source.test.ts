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
    expect(home).toContain("t('aiTeammateCount')");
    expect(home).not.toContain('Primary AI 팀원');
  });

  it('separates the Tower helper from teammates and opens creation directly', () => {
    expect(home).toContain("project.systemKey === 'ai-talent-team'");
    expect(home).toContain("project.systemKey !== 'ai-talent-team'");
    expect(home).toContain("new CustomEvent('tower-start-agent-academy')");
    expect(home).toContain("t('aiTeamHelper')");
    expect(home).toContain('onNewSession(helper.id)');
    expect(home).not.toContain('AI 인재팀');
    expect(home).toContain("t('newAiTeammate')");
    expect(home).toContain("{t('workspace')} · {project.name}");
    expect(header).not.toContain('label={t(\'newProject\')}');
    expect(header).not.toContain('label="새 에이전트"');
  });

  it('uses visible sessions and offers teammate-home and recent-conversation actions', () => {
    expect(home).not.toContain('/api/sessions');
    expect(home).toContain("t('recentConversation')");
    expect(home).toContain("t('openTeammateHome'");
    expect(home).toContain('onOpenProjectHome(project)');
  });

  it('uses the quiet control-room surface and unified statistics hierarchy', () => {
    expect(home).toContain('ai-team-control-room');
    expect(home).toContain('ai-team-hero');
    expect(home).toContain('ai-team-stats');
    expect(home).toContain('ai-team-stat');
    expect(home).toContain('ai-team-member-card');
    expect(home).not.toContain('shadow-xl shadow-black/20');
  });

  it('keeps narrow layouts usable without fixed card widths', () => {
    expect(home).toContain('min-w-0');
    expect(home).toContain('w-full');
    expect(home).not.toMatch(/w-\[(?:[3-9]\d\d|\d{4,})px\]/);
  });
});
