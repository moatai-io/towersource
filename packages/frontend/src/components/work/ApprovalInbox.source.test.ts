import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './ApprovalInbox.tsx'), 'utf8');
const timeline = fs.readFileSync(path.resolve(import.meta.dirname, './ChallengeTimelinePanel.tsx'), 'utf8');

describe('My Work Approval Inbox source contract', () => {
  it('shows assigned and sent projections from the Approval Card API', () => {
    expect(source).toContain("(['assigned', 'sent'] as const)");
    expect(source).toContain('onClick={() => setBox(value)}');
    expect(source).toContain('/api/approval-cards?box=');
  });

  it('retries transient connection failures and translates raw fetch errors', () => {
    expect(source).toContain('async function approvalFetch');
    expect(source).toContain('retries = 1');
    expect(source).toContain('12_000');
    expect(source).toContain("approvalInbox.error.connection");
    expect(source).not.toContain("setError(errorMessage(err, 'Failed to fetch'))");
  });

  it('separates list, detail, and resolution loading states', () => {
    expect(source).toContain('listLoading');
    expect(source).toContain('detailLoading');
    expect(source).toContain('resolving');
    expect(source).toContain('new AbortController()');
  });

  it('supports approve, request changes, reject, and Session review', () => {
    expect(source).toContain("resolve('approved')");
    expect(source).toContain("resolve('changes_requested')");
    expect(source).toContain("resolve('rejected')");
    expect(source).toContain("new CustomEvent('kanban-select-session'");
    expect(source).toContain('role="tablist"');
    expect(source).toContain('aria-selected');
  });

  it('does not reserve permanent space in the AI activity briefing', () => {
    expect(timeline).not.toContain("import { ApprovalInbox } from './ApprovalInbox'");
    expect(timeline).not.toContain('<ApprovalInbox />');
  });
});
