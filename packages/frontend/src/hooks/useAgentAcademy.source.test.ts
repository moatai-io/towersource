import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const academy = readFileSync(new URL('./useAgentAcademy.ts', import.meta.url), 'utf8');

describe('Agent Academy ownership', () => {
  it('keeps App on academy state wiring', () => {
    expect(app).toContain('useAgentAcademy(sendMessage)');
    expect(app).not.toContain('buildInitialAgentAcademyDraft');
    expect(app).not.toContain("window.addEventListener('tower-start-agent-academy'");
  });

  it('selects an active accessible project and removes only legacy creator tabs', () => {
    expect(academy).toContain('project.id === activeProjectId && !project.archived');
    expect(academy).toContain("project.systemKey !== 'ai-talent-team'");
    expect(academy).toContain('/^agent-drafts\\/new-agent(?:-\\d+)?\\.agent-draft\\.json$/');
    expect(academy).toContain('draft.sourceProjectId = sourceProject?.id');
  });

  it('routes creator events to AI Team and custom character requests to chat', () => {
    expect(academy).toContain("setAiTeamSurface('creator')");
    expect(academy).toContain("sessionState.setActiveView('aiTeam')");
    expect(academy).toContain("window.addEventListener('tower-open-ai-team-home'");
    expect(academy).toContain("window.addEventListener('tower-start-agent-academy'");
    expect(academy).toContain("window.addEventListener('tower-request-custom-agent-character'");
    expect(academy).toContain("useSessionStore.getState().setActiveView('chat')");
  });
});
