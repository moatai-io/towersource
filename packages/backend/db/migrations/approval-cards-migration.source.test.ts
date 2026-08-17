import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(import.meta.dirname, '110_approval_cards.sql'), 'utf8');
const followup = fs.readFileSync(path.resolve(import.meta.dirname, '111_approval_cards_submitter_type.sql'), 'utf8');

describe('Approval Cards migration contract', () => {
  it('keeps card state canonical with immutable revisions, attachments, and events', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS approval_cards');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS approval_card_revisions');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS approval_card_attachments');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS approval_card_events');
    expect(migration).toContain("CHECK (status IN ('pending', 'approved', 'changes_requested', 'rejected', 'cancelled', 'stale'))");
    expect(migration).toContain('UNIQUE(card_id, revision_no)');
  });

  it('binds cards to one project Agent Workspace and one human approver', () => {
    expect(migration).toContain('project_id               TEXT NOT NULL REFERENCES projects(id)');
    expect(migration).toContain("CHECK (submitter_type IN ('user', 'workspace_agent'))");
    expect(followup).toContain('ADD COLUMN IF NOT EXISTS submitter_type');
    expect(migration).toContain('approver_user_id         INTEGER NOT NULL REFERENCES users(id)');
  });
});
