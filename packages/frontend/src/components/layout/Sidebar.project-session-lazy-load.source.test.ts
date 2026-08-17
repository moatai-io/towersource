import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './Sidebar.tsx'), 'utf8');

describe('Sidebar project session lazy-load contract', () => {
  it('hydrates a selected teammate project before rendering its conversation list from the session store', () => {
    expect(source).toContain('const sidebarProjectSessionsLoaded = new Set<string>();');
    expect(source).toContain('const sidebarProjectSessionsLoading = new Set<string>();');
    expect(source).toContain('const mergeSessions = useSessionStore((s) => s.mergeSessions);');
    expect(source).toContain('const projectId = selectedAgentProjectId;');
    expect(source).toContain('new URLSearchParams({ projectId })');
    expect(source).toContain('fetch(`/api/sessions?${params.toString()}`');
    expect(source).toContain('if (Array.isArray(data)) mergeSessions(data);');
  });

  it('shows teammate conversation counts from the same filtered session set used by the visible list', () => {
    expect(source).toContain('const filteredSessionCountByProject = useMemo(() => {');
    expect(source).toContain('for (const session of filteredSessions)');
    expect(source).toContain('const visibleCount = filteredSessionCountByProject.get(project.id) || 0;');
    expect(source).toContain("{t('conversationCount', { count: visibleCount })}");
    expect(source).toContain('const conversationCount = [...filteredSessionCountByProject.values()].reduce((sum, count) => sum + count, 0);');
  });
});
