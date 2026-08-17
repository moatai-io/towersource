import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.resolve(__dirname, 'App.tsx'), 'utf8');

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

  it('opens the creator artifact directly, leaves Team Home, and keeps mobile fullscreen support', () => {
    const academyStart = source.indexOf("window.addEventListener('tower-start-agent-academy'");
    const academyBlock = source.slice(source.lastIndexOf('useEffect(() => {', academyStart), academyStart);
    expect(academyBlock).toContain("mobileHiring ? { split: 'right', name: '새 AI 동료' } : { name: '새 AI 동료' }");
    expect(academyBlock).toContain("useSessionStore.getState().setActiveView('chat')");
    expect(academyBlock).toContain('useSessionStore.getState().openMobileContext(false)');
    expect(academyBlock.indexOf("setActiveView('chat')")).toBeGreaterThan(academyBlock.indexOf("'agent-draft'"));
  });
});
