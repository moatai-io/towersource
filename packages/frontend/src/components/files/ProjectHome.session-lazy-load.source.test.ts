import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const projectHomeSource = fs.readFileSync(path.join(import.meta.dirname, 'ProjectHome.tsx'), 'utf8');
const sessionStoreSource = fs.readFileSync(path.resolve(import.meta.dirname, '../../stores/session-store.ts'), 'utf8');

describe('ProjectHome session lazy-load contract', () => {
  it('loads missing active sessions for the opened project and merges them into the session store', () => {
    expect(projectHomeSource).toContain('const projectSessionsLoaded = new Set<string>();');
    expect(projectHomeSource).toContain('const projectSessionsLoading = new Set<string>();');
    expect(projectHomeSource).toContain('const mergeSessions = useSessionStore((s) => s.mergeSessions);');
    expect(projectHomeSource).toContain('new URLSearchParams({ projectId })');
    expect(projectHomeSource).toContain('fetch(`/api/sessions?${params.toString()}`');
    expect(projectHomeSource).toContain('if (Array.isArray(data)) mergeSessions(data);');
  });

  it('merges lazy-loaded project sessions without replacing the startup recent window', () => {
    expect(sessionStoreSource).toContain('mergeSessions: (sessions: SessionMeta[]) => void;');
    expect(sessionStoreSource).toContain('for (const session of s.sessions) byId.set(session.id, session);');
    expect(sessionStoreSource).toContain('for (const session of sessions) byId.set(session.id, session);');
    expect(sessionStoreSource).toContain('return { sessions: merged };');
  });
});
