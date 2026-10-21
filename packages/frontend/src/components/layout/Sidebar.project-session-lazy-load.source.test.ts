import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './Sidebar.tsx'), 'utf8');

describe('Sidebar project session lazy-load contract', () => {
  it('hydrates a selected teammate project through the shared session-store action', () => {
    expect(source).toContain('const hydrateProjectSessions = useSessionStore((s) => s.hydrateProjectSessions);');
    expect(source).toContain('void hydrateProjectSessions(selectedAgentProjectId);');
    expect(source).not.toContain('const sidebarProjectSessionsLoaded = new Set<string>();');
    expect(source).not.toContain('fetch(`/api/sessions?${params.toString()}`');
  });

  it('uses the server aggregate before project hydration and the filtered full list after hydration', () => {
    expect(source).toContain('const filteredSessionCountByProject = useMemo(() => {');
    expect(source).toContain('for (const session of filteredSessions)');
    expect(source).toContain('const hydratedProjectSessionIds = useSessionStore((s) => s.hydratedProjectSessionIds);');
    expect(source).toContain('const visibleCount = hydratedProjectSessionIds.has(project.id)');
    expect(source).toContain('(project.sessionCount ?? filteredSessionCountByProject.get(project.id) ?? 0)');
    expect(source).toContain("{t('conversationCount', { count: visibleCount })}");
  });
});
