import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const timeline = fs.readFileSync(path.resolve(import.meta.dirname, './ChallengeTimelinePanel.tsx'), 'utf8');
const approval = fs.readFileSync(path.resolve(import.meta.dirname, './ApprovalInbox.tsx'), 'utf8');

describe('My Work agent activity surface', () => {
  it('frames history as an AI activity briefing with agent faces', () => {
    expect(timeline).toContain('AI 팀 활동');
    expect(timeline).toContain('같은 AI 팀원의 업무를 묶어 최근 항목부터 보여줍니다.');
    expect(timeline).toContain('최근 업무 {group.items.length}건');
    expect(timeline).toContain('<AgentFace session={group.session} />');
    expect(timeline).toContain('session.agentName');
  });

  it('retries transient Approval Card fetch failures and translates browser network copy', () => {
    expect(approval).toContain('async function approvalFetch');
    expect(approval).toContain('/failed to fetch/i');
    expect(approval).toContain('승인함 연결이 잠시 끊겼습니다');
  });
});
