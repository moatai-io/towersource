import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sidebar = fs.readFileSync(path.resolve(import.meta.dirname, './Sidebar.tsx'), 'utf8');
const rail = fs.readFileSync(path.resolve(import.meta.dirname, './AgentNavigationRail.tsx'), 'utf8');
const item = fs.readFileSync(path.resolve(import.meta.dirname, '../sessions/SessionItem.tsx'), 'utf8');

describe('Agent identity in Sidebar teammate rail', () => {
  it('uses a dedicated desktop teammate rail with borderless list-cropped identities', () => {
    expect(rail).toContain("aria-label={t('agentNavigation')}");
    expect(rail).toContain('projects.map');
    expect(rail).toContain('<AgentIdentityAvatar project={project} variant="list" showListAccent={false} className="h-7 w-7 shrink-0 rounded-lg"');
    expect(sidebar).toContain('width={agentNavWidth}');
  });

  it('keeps AI Team, Work and teammate selection as distinct navigation scopes', () => {
    expect(rail).toContain("aria-label={t('openAiTeamHome')}");
    expect(rail).toContain("aria-label={t('openRecentConversations')}");
    expect(sidebar).toContain("setAgentNavScope('team')");
    expect(sidebar).toContain("setAgentNavScope('work')");
    expect(sidebar).toContain('setSelectedAgentProjectId(project.id)');
    expect(sidebar).toContain('navigationGroupedSessions');
  });

  it('exposes running state accessibly without adding a competing visual marker', () => {
    expect(sidebar).toContain('Filters reshape only the right pane');
    expect(sidebar).toContain('projectSessions.some((session) => streamingSessions.has(session.id))');
    expect(rail).toContain('{running && <span className="sr-only">');
    expect(rail).not.toContain('tone-success h-2 w-2');
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
    for (const token of ['deriveSessionRowState', 'onSelect(session)', 'deriveSessionRowState(activity, isUnreadAttention)', 'queueCount']) {
      expect(item).toContain(token);
    }
    expect(sidebar).toContain('markSessionRead(sessionId)');
    for (const token of ['latestQuickSessions', 'groupedSessions', 'streamingSessions', 'selectedAgentProjectId']) {
      expect(sidebar).toContain(token);
    }
  });
});
