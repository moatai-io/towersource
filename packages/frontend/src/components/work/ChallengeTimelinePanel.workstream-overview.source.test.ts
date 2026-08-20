import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './ChallengeTimelinePanel.tsx'), 'utf8');

describe('Workstream overview surface', () => {
  it('opens a canonical overview from activity rows and returns to team activity', () => {
    expect(source).toContain('function WorkstreamOverview');
    expect(source).toContain('onClick={() => onSelectWorkstream(key)}');
    expect(source).toContain('onBack={returnToActivity}');
    expect(source).toContain("tr('challenge.timeline.title')");
  });

  it('puts current and completed steps before results and supporting context', () => {
    const currentProgress = source.indexOf("tr('challenge.timeline.currentProgress')");
    const results = source.indexOf("tr('challenge.timeline.resultsAndDecisions')");
    const conversations = source.indexOf("tr('challenge.timeline.relatedConversations')");
    expect(currentProgress).toBeGreaterThan(0);
    expect(currentProgress).toBeLessThan(results);
    expect(currentProgress).toBeLessThan(conversations);
  });

  it('answers status, progress, next action and provenance questions', () => {
    for (const key of ['progressSteps', 'currentProgress', 'resultsAndDecisions', 'relatedConversations', 'nextCandidates', 'assignedAi', 'collaborators']) {
      expect(source).toContain(`challenge.timeline.${key}`);
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
