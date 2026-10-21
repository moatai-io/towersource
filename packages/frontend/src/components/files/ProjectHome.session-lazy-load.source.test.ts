import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const projectHomeSource = fs.readFileSync(path.join(import.meta.dirname, 'ProjectHome.tsx'), 'utf8');
const sessionStoreSource = fs.readFileSync(path.resolve(import.meta.dirname, '../../stores/session-store.ts'), 'utf8');

describe('ProjectHome session lazy-load contract', () => {
  it('delegates opened-project hydration to the shared session-store action', () => {
    expect(projectHomeSource).toContain('const hydrateProjectSessions = useSessionStore((s) => s.hydrateProjectSessions);');
    expect(projectHomeSource).toContain('void hydrateProjectSessions(project.id);');
    expect(projectHomeSource).not.toContain('const projectSessionsLoaded = new Set<string>();');
    expect(projectHomeSource).not.toContain('fetch(`/api/sessions?${params.toString()}`');
  });

  it('keeps project hydration state and reconciliation in the shared store', () => {
    expect(sessionStoreSource).toContain('hydrateProjectSessions: (projectId: string');
    expect(sessionStoreSource).toContain('hydratedProjectSessionIds: Set<string>;');
    // Preserve sessions created while a project snapshot request is in flight.
    expect(sessionStoreSource).toContain('const initialIds = new Set(initial.sessions.map(session => session.id));');
    expect(sessionStoreSource).toContain('if (session.projectId !== projectId || !initialIds.has(session.id)) byId.set(session.id, session);');
    expect(sessionStoreSource).toContain('hydratedProjectSessionIds.add(projectId);');
  });
});
