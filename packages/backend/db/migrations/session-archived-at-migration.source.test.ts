import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const columnMigration = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/203_session_archived_at_column.sql'), 'utf8');
const backfillMigration = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/204_session_archived_at_backfill.sql'), 'utf8');
const sessionManager = fs.readFileSync(path.join(process.cwd(), 'packages/backend/services/session/session-manager.ts'), 'utf8');

describe('Session archived_at migration', () => {
  it('splits the column DDL and the backfill across ordered migration files', () => {
    expect(columnMigration).toContain('ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ');
    expect(columnMigration).not.toMatch(/\bUPDATE\s+sessions\b/i);
    expect(backfillMigration).toContain('SET archived_at = updated_at');
    expect(backfillMigration).toContain('WHERE archived = 1');
    expect(backfillMigration).not.toMatch(/\bALTER\s+TABLE\b/i);
  });

  it('archive/restore keep updated_at at true last-activity and use archived_at', () => {
    const archive = sessionManager.slice(
      sessionManager.indexOf('export async function deleteSession'),
      sessionManager.indexOf('export async function getArchivedSessions')
    );
    expect(archive).toContain('archived_at = CURRENT_TIMESTAMP');
    expect(archive).not.toContain('updated_at = CURRENT_TIMESTAMP');

    const restoreStart = sessionManager.indexOf('export async function restoreSession');
    const restore = sessionManager.slice(restoreStart, restoreStart + 900);
    expect(restore).toContain('archived = 0, archived_at = NULL');
    expect(restore).not.toContain('updated_at = CURRENT_TIMESTAMP');

    const historyStart = sessionManager.indexOf('export async function getArchivedSessions');
    const history = sessionManager.slice(historyStart, historyStart + 2400);
    expect(history).toContain('ORDER BY COALESCE(s.archived_at, s.updated_at) DESC');
  });
});
