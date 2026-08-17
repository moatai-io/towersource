import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const routerSource = fs.readFileSync(path.join(import.meta.dirname, 'session-core-router.ts'), 'utf8');
const managerSource = fs.readFileSync(path.resolve(import.meta.dirname, '../../services/session/session-manager.ts'), 'utf8');
const getSessionsSource = managerSource.slice(
  managerSource.indexOf('export async function getSessions'),
  managerSource.indexOf('/**\n * Convert a `sessions` row to SessionMeta.')
);

describe('session list recent-window contract', () => {
  it('accepts a bounded limit on GET /sessions and passes sidebar filtering to the manager', () => {
    expect(routerSource).toContain("Number.parseInt(String(req.query.limit ?? ''), 10)");
    expect(routerSource).toContain('Math.min(rawLimit, 1000)');
    expect(routerSource).toContain("const projectId = typeof req.query.projectId === 'string'");
    expect(routerSource).toContain('getSessions(userId, role, { limit, projectId, sidebarOnly: true })');
  });

  it('applies sidebar visibility and limit before returning session metadata rows', () => {
    expect(managerSource).toContain('export type GetSessionsOptions');
    expect(managerSource).toContain('projectId?: string;');
    expect(managerSource).toContain('s.project_id = $');
    expect(managerSource).toContain("(s.parent_session_id IS NULL OR s.label IN ('spawned', 'agent', 'conversation_branch'))");
    expect(managerSource).toContain("(s.room_id IS NULL OR s.label = 'channel_ai')");
    expect(getSessionsSource).toContain('WITH visible_sessions AS');
    expect(getSessionsSource).toContain('FROM visible_sessions s');
    expect(getSessionsSource).toContain('${limitClause}');
  });

  it('does not aggregate message metadata across the entire messages table before LIMIT', () => {
    expect(getSessionsSource).toContain('LEFT JOIN LATERAL (\n      SELECT COUNT(*) AS cnt\n      FROM messages m\n      WHERE m.session_id = s.id');
    expect(getSessionsSource).not.toContain('FROM messages\n      WHERE role =');
    expect(getSessionsSource).not.toContain('GROUP BY session_id');
  });
});
