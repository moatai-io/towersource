import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './Sidebar.tsx'), 'utf8');
const toolbar = fs.readFileSync(path.resolve(import.meta.dirname, '../../features/navigation-sidebar/sessions/SidebarSessionsToolbar.tsx'), 'utf8');

describe('AI navigation density and Work-first contract', () => {
  it('uses a collapsible desktop rail and an independently scrolling conversation pane', () => {
    expect(source).toContain("agentNavExpanded ? 'is-expanded w-44' : 'w-14'");
    expect(source).toContain('min-[769px]:flex');
    expect(source).toContain('scrollbar-none min-h-0 w-40 flex-1 overflow-y-auto overflow-x-hidden');
    expect(source).toContain('scrollbar-none h-full min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden');
  });

  it('keeps Work above Team Home inside AI navigation, not as a top navigation tab', () => {
    expect(source).toContain("title={t('aiTeamNavTitle')}");
    expect(source).toContain("title={t('workNavTitle')}");
    expect(source).toContain("agentNavScope === 'team'");
    expect(source).toContain("agentNavScope === 'work'");
    expect(source.indexOf("title={t('workNavTitle')}")).toBeLessThan(source.indexOf("title={t('aiTeamNavTitle')}"));
  });

  it('opens Team Home immediately and returns Work to the conversation surface', () => {
    const workButton = source.slice(source.indexOf("title={t('workNavTitle')}") - 700, source.indexOf("title={t('workNavTitle')}") + 400);
    const teamHomeButton = source.slice(source.indexOf("title={t('aiTeamNavTitle')}") - 700, source.indexOf("title={t('aiTeamNavTitle')}") + 400);
    expect(workButton).toContain("setAgentNavScope('work')");
    expect(workButton).toContain('activateChatSlot()');
    expect(workButton).toContain("setActiveView('chat')");
    expect(teamHomeButton).toContain("setAgentNavScope('team')");
    expect(teamHomeButton).toContain("setActiveView('aiTeam')");
    expect(source).not.toContain("t('openTeamHome')");
  });

  it('uses sequential root and detail panes on mobile', () => {
    expect(source).toContain('const [mobileAgentPane, setMobileAgentPane] = useState<MobileAgentPane>');
    expect(source).toContain('data-mobile-agent-pane="root"');
    expect(source).toContain('data-mobile-agent-pane="detail"');
    expect(source).toContain("setMobileAgentPane('detail')");
    expect(source).toContain("setMobileAgentPane('root')");
    expect(source).toContain("aria-label={t('backToAiNavigation')}");
    expect(source).toContain('key={`mobile-agent-${project.id}`}');
    expect(source).not.toContain('scrollbar-none mt-2 flex snap-x');
    expect(source).not.toContain('min-[769px]:hidden"><AgentTeamFormationTicket');
  });

  it('keeps filtering in the toolbar instead of duplicating a full-width filter row', () => {
    expect(toolbar).toContain('onClick={() => setFilterOpen(!filterOpen)}');
    expect(source).not.toContain("activeFilterLabels.join(' · ')");
  });

  it('does not render a redundant Recent Conversations collapse header in Work', () => {
    expect(source).not.toContain('{latestTotal.toLocaleString()}');
    expect(source).not.toContain('latestSessionsCollapsed');
    expect(source).not.toContain('toggleLatestSessionsCollapsed');
    expect(source).not.toContain('>({latestTotal})</span>');
  });
});
