import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const app = fs.readFileSync(path.resolve(__dirname, 'App.tsx'), 'utf8');
const academy = fs.readFileSync(path.resolve(__dirname, 'hooks/useAgentAcademy.ts'), 'utf8');
const source = `${app}\n${academy}`;

describe('direct AI teammate creator routing', () => {
  it('uses an accessible active Project as approval context and creates no helper Session', () => {
    expect(source).toContain('project.id === activeProjectId && !project.archived');
    expect(source).toContain("project.systemKey !== 'ai-talent-team'");
    expect(source).toContain('draft.sourceProjectId = sourceProject?.id');
    expect(source).not.toContain('AI talent team seed project is unavailable');
    expect(source).not.toContain("createSessionInDb('AI 인재팀과 새 직원 찾기'");
    expect(source).not.toContain('당신은 Tower의 “AI 인재팀”');
    expect(source).not.toContain('agent-academy-greeting');
  });

  it('opens creation as an AI Team subview without creating a file or Viewer tab', () => {
    const academyStart = academy.indexOf('const openAgentAcademy = useCallback');
    const academyEnd = academy.indexOf('const closeAgentAcademy', academyStart);
    const academyBlock = academy.slice(academyStart, academyEnd);
    expect(academyBlock).toContain("setAiTeamSurface('creator')");
    expect(academyBlock).toContain("sessionState.setActiveView('aiTeam')");
    expect(academyBlock).toContain('setAgentCreatorContent(JSON.stringify(draft, null, 2))');
    expect(academyBlock).not.toContain('openTab');
    expect(academyBlock).not.toContain('openSplitTab');
    expect(academyBlock).not.toContain("split: 'right'");
    expect(academyBlock).toContain("/^agent-drafts\\/new-agent(?:-\\d+)?\\.agent-draft\\.json$/");
    expect(academyBlock).toContain('closeTab(tab.id)');
    expect(source).toContain('<AgentDraftPreview content={agentCreatorContent} onCancel={closeAgentAcademy} />');
    expect(source).toContain("setAiTeamSurface('home')");
    expect(source).toContain("window.addEventListener('tower-open-ai-team-home', closeAgentAcademy)");
  });
});
