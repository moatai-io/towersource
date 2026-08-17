import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sidebar = fs.readFileSync(path.resolve(import.meta.dirname, './Sidebar.tsx'), 'utf8');
const item = fs.readFileSync(path.resolve(import.meta.dirname, '../sessions/SessionItem.tsx'), 'utf8');

describe('Agent identity in Sidebar teammate rail', () => {
  it('uses a dedicated desktop teammate rail with borderless list-cropped identities', () => {
    expect(sidebar).toContain("aria-label={t('agentNavigation')}");
    expect(sidebar).toContain('agentRailProjects.map');
    expect(sidebar).toContain('<AgentIdentityAvatar project={project} variant="list" showListAccent={false} className="h-7 w-7 shrink-0 rounded-lg"');
    expect(sidebar).toContain("agentNavExpanded ? 'is-expanded w-44' : 'w-14'");
  });

  it('keeps AI Team, Work and teammate selection as distinct navigation scopes', () => {
    expect(sidebar).toContain("aria-label={t('openAiTeamHome')}");
    expect(sidebar).toContain("aria-label={t('openRecentConversations')}");
    expect(sidebar).toContain("setAgentNavScope('team')");
    expect(sidebar).toContain("setAgentNavScope('work')");
    expect(sidebar).toContain('setSelectedAgentProjectId(project.id)');
    expect(sidebar).toContain('navigationGroupedSessions');
  });

  it('shows running state in the teammate rail independently from conversation filters', () => {
    expect(sidebar).toContain('Filters reshape only the right pane');
    expect(sidebar).toContain('projectSessions.some((session) => streamingSessions.has(session.id))');
    expect(sidebar).toContain("tone-success h-2 w-2");
  });

  it('uses a mobile master-detail drill down instead of nested project navigation', () => {
    expect(sidebar).toContain("mobileAgentPane === 'root'");
    expect(sidebar).toContain('data-mobile-agent-pane="root"');
    expect(sidebar).toContain('data-mobile-agent-pane="detail"');
    expect(sidebar).toContain('key={`mobile-agent-${project.id}`}');
    expect(sidebar).toContain("agentFirstEnabled ? 'hidden' : 'pt-1'");
    expect(sidebar).not.toContain('min-[769px]:hidden"><AgentTeamFormationTicket');
  });

  it('preserves existing session status and selection contracts', () => {
    for (const token of ['deriveSessionRowState', 'markSessionRead(session.id)', 'onSelect(session)', 'deriveSessionRowState(activity, isUnreadAttention)', 'queueCount']) {
      expect(item).toContain(token);
    }
    for (const token of ['latestQuickSessions', 'groupedSessions', 'streamingSessions', 'selectedAgentProjectId']) {
      expect(sidebar).toContain(token);
    }
  });
});
