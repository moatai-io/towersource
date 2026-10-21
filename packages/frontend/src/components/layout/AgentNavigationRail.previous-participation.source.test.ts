import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const rail = readFileSync(new URL('./AgentNavigationRail.tsx', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
describe('previous participation has no content or execution entry point', () => {
  it('renders history as non-interactive names and explicit membership state', () => {
    const section = rail.slice(rail.indexOf('{previousAgents.length'), rail.indexOf('data-tour-id="agent-rail-create"'));
    expect(section).toContain("t('previousParticipation')");
    expect(section).toContain("t('notParticipating')");
    expect(section).toContain("t('previousParticipationHint')");
    expect(section).not.toContain('onSelectProject');
    expect(section).not.toContain('onClick');
  });
  it('loads history independently without inserting inaccessible projects into the project store', () => {
    expect(sidebar).toContain('/api/agent-directory/previous-participation');
    expect(sidebar).toContain('controller.abort()');
    expect(sidebar).toContain('!allProjects.some((project) => project.id === agent.id)');
  });
});
