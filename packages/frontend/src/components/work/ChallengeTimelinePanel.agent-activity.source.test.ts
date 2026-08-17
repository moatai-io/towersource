import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './ChallengeTimelinePanel.tsx'), 'utf8');

describe('My Work agent activity projection', () => {
  it('presents delegated runs as a user-centric chronological activity briefing', () => {
    expect(source).toContain('AI 팀 활동');
    expect(source).toContain('최근 활동');
    expect(source).toContain('같은 AI 팀원의 업무를 묶어 최근 항목부터 보여줍니다.');
    expect(source).toContain('expandedAgents');
    expect(source).toContain('group.items.slice(0, 3)');
    expect(source).toContain(".sort((a, b) => new Date(b.session.lastAt).getTime() - new Date(a.session.lastAt).getTime())");
    expect(source).toContain('session.agentName');
    expect(source).toContain('<AgentFace session={group.session} />');
    expect(source).toContain('onClick={() => onSelectWorkstream(key)}');
    expect(source).toContain('<WorkstreamOverview challenge={selectedChallenge}');
  });

  it('uses the agent face snapshot with a stable project-based fallback', () => {
    expect(source).toContain('agentFaceImageUrl(session.agentFace)');
    expect(source).toContain('characterFace(session.agentFace)');
    expect(source).toContain('distributedKoreanCharacterId(session.projectId || session.id)');
  });
});
