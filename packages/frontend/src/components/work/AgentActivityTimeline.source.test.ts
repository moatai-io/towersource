import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const timeline = fs.readFileSync(path.resolve(import.meta.dirname, './ChallengeTimelinePanel.tsx'), 'utf8');
const approval = fs.readFileSync(path.resolve(import.meta.dirname, './ApprovalInbox.tsx'), 'utf8');

describe('My Work actual work surface', () => {
  it('shows one row per Workstream with current step, progress, and assigned AI', () => {
    expect(timeline).toContain("tr('challenge.timeline.workList')");
    expect(timeline).toContain("tr('challenge.timeline.workListDescription')");
    expect(timeline).toContain('.flatMap((project) => project.challenges)');
    expect(timeline).toContain('challenge.todoDone}/${challenge.todoTotal}');
    expect(timeline).toContain('const agentNames = Array.from(new Set(sessions.map((session) => session.agentName)))');
    expect(timeline).not.toContain('Activity briefing');
    expect(timeline).not.toContain('<Stat label=');
  });

  it('retries transient Approval Card fetch failures and translates browser network copy', () => {
    expect(approval).toContain('async function approvalFetch');
    expect(approval).toContain('/failed to fetch/i');
    expect(approval).toContain("approvalInbox.error.connection");
  });
});
