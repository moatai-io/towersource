import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const timeline = fs.readFileSync(path.resolve(__dirname, 'ChallengeTimelinePanel.tsx'), 'utf8');
const approvals = fs.readFileSync(path.resolve(__dirname, 'ApprovalInbox.tsx'), 'utf8');

describe('work surface locale contracts', () => {
  it('routes timeline status, summary, detail, and empty states through common locale keys', () => {
    for (const key of [
      'challenge.timeline.status.needsReview',
      'challenge.timeline.title',
      'challenge.timeline.currentProgress',
      'challenge.timeline.resultsAndDecisions',
      'challenge.timeline.relatedConversations',
      'challenge.timeline.noSessionInfo',
    ]) expect(timeline).toContain(key);
  });

  it('routes approval statuses, actions, errors, and review guidance through common locale keys', () => {
    for (const key of [
      'approvalInbox.status.',
      'approvalInbox.resolution.',
      'approvalInbox.error.connection',
      'approvalInbox.title',
      'approvalInbox.reviewMaterials',
      'approvalInbox.approvalNotDeployment',
    ]) expect(approvals).toContain(key);
  });
});
