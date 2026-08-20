import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const timeline = fs.readFileSync(path.resolve(import.meta.dirname, './ChallengeTimelinePanel.tsx'), 'utf8');
const approval = fs.readFileSync(path.resolve(import.meta.dirname, './ApprovalInbox.tsx'), 'utf8');

describe('My Work agent activity surface', () => {
  it('frames history as an AI activity briefing with agent faces', () => {
    expect(timeline).toContain("tr('challenge.timeline.recentActivity')");
    expect(timeline).toContain("tr('challenge.timeline.groupDescription')");
    expect(timeline).toContain("tr('challenge.timeline.recentWorkCount'");
    expect(timeline).toContain('<AgentFace session={group.session} />');
    expect(timeline).toContain('session.agentName');
  });

  it('retries transient Approval Card fetch failures and translates browser network copy', () => {
    expect(approval).toContain('async function approvalFetch');
    expect(approval).toContain('/failed to fetch/i');
    expect(approval).toContain("approvalInbox.error.connection");
  });
});
