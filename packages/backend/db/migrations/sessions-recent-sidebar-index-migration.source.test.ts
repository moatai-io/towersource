import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/174_sessions_recent_sidebar_index.sql'), 'utf8');
const sessionManager = fs.readFileSync(path.join(process.cwd(), 'packages/backend/services/session/session-manager.ts'), 'utf8');

describe('recent sidebar Session index', () => {
  it('indexes the active sessions updated_at order used by startup recent-window loading', () => {
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS idx_sessions_recent_active_updated');
    expect(migration).toContain('ON sessions(updated_at DESC)');
    expect(migration).toContain('WHERE archived IS NULL OR archived = 0');
  });

  it('matches getSessions visible window ordering before metadata joins', () => {
    const getSessionsSource = sessionManager.slice(
      sessionManager.indexOf('export async function getSessions'),
      sessionManager.indexOf('/**\n * Convert a `sessions` row to SessionMeta.')
    );
    expect(getSessionsSource).toContain("const where: string[] = ['(s.archived IS NULL OR s.archived = 0)'];");
    expect(getSessionsSource).toContain('WITH visible_sessions AS');
    expect(getSessionsSource).toContain('ORDER BY s.updated_at DESC');
    expect(getSessionsSource).toContain('${limitClause}');
  });
});
