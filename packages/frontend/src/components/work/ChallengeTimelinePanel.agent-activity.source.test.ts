import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './ChallengeTimelinePanel.tsx'), 'utf8');

describe('My Work progress projection', () => {
  it('presents one canonical row per Workstream with current progress first', () => {
    expect(source).toContain("tr('challenge.timeline.title')");
    expect(source).toContain("tr('challenge.timeline.workList')");
    expect(source).toContain("tr('challenge.timeline.currentProgress')");
    expect(source).toContain("tr('challenge.timeline.resultsAndDecisions')");
    expect(source).toContain(".sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime())");
    expect(source).toContain('session.agentName');
    expect(source).toContain('onClick={() => onSelectWorkstream(key)}');
    expect(source).toContain('<WorkstreamOverview challenge={selectedChallenge}');
  });

  it('keeps assigned AI identity visible in list and overview summaries', () => {
    expect(source).toContain('const agentNames = Array.from(new Set(sessions.map((session) => session.agentName))).join');
    expect(source).toContain("tr('challenge.timeline.assignedAi'");
    expect(source).toContain("tr('challenge.timeline.relatedConversations')");
  });
});
