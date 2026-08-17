import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './ChallengeTimelinePanel.tsx'), 'utf8');

describe('Workstream overview surface', () => {
  it('opens a canonical overview from activity rows and returns to team activity', () => {
    expect(source).toContain('function WorkstreamOverview');
    expect(source).toContain('onClick={() => onSelectWorkstream(key)}');
    expect(source).toContain('onBack={returnToActivity}');
    expect(source).toContain('←</span> AI 팀 활동');
  });

  it('answers status, progress, next action and provenance questions', () => {
    for (const copy of ['진행 단계', '현재 진행 단계', '결과와 판단', '관련 대화', '다음 후보', '담당 AI', '협업 사용자']) {
      expect(source).toContain(copy);
    }
    expect(source).toContain('workstreamActionLabel(challenge)');
    expect(source).toContain('challenge.todoDone / challenge.todoTotal');
    expect(source).toContain('openSession(primarySession.id)');
  });

  it('uses a responsive one-column layout before the desktop split', () => {
    expect(source).toContain('lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,.75fr)]');
    expect(source).toContain('md:grid-cols-2');
    expect(source).toContain('[word-break:keep-all]');
  });
});
