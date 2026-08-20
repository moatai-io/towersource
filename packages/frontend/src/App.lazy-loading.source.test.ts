import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const appSource = fs.readFileSync(path.resolve(import.meta.dirname, './App.tsx'), 'utf8');
const mainSource = fs.readFileSync(path.resolve(import.meta.dirname, './main.tsx'), 'utf8');
const richContentSource = fs.readFileSync(path.resolve(import.meta.dirname, './components/shared/RichContent.tsx'), 'utf8');
const viteSource = fs.readFileSync(path.resolve(import.meta.dirname, '../../../vite.config.ts'), 'utf8');

describe('frontend startup session loading boundaries', () => {
  it('does not use the full sessions list as a token validation probe', () => {
    expect(appSource).toContain('fetchWithRestartTolerantAuth(`${API_BASE}/auth/check`');
    expect(appSource).not.toContain('auth 상태 검증 (401만 로그아웃 — 네트워크 에러는 유지)\n        if (status.authEnabled && token) {\n          try {\n            const r = await fetchWithRestartTolerantAuth(`${API_BASE}/sessions`');
  });

  it('loads only the recent startup session window without replacing hydrated project lists', () => {
    expect(appSource).toContain('const STARTUP_SESSION_LIST_LIMIT = 200;');
    expect(appSource).toContain('fetchWithRestartTolerantAuth(`${API_BASE}/sessions?limit=${STARTUP_SESSION_LIST_LIMIT}`');
    expect(appSource).toContain('const setRecentSessions = useSessionStore((s) => s.setRecentSessions);');
    expect(appSource).not.toContain('fetchWithRestartTolerantAuth(`${API_BASE}/sessions`, { headers })');
    expect(appSource).not.toContain('setSessions(next);');
  });

  it('deduplicates startup session list loading for unchanged auth state', () => {
    expect(appSource).toContain('startupSessionsLoadRef');
    expect(appSource).toContain('if (sessionsLoaded && startupSessionsLoadRef.current.key === startupKey) return;');
    expect(appSource).toContain('if (startupSessionsLoadRef.current.inFlight && startupSessionsLoadRef.current.key === startupKey) return;');
  });

  it('can restore the last viewed session outside the recent startup window', () => {
    expect(appSource).toContain('const session = await res.json();\n            useSessionStore.getState().addSession(session);\n            await handleSelectSession(session);');
  });
});

describe('frontend lazy-loading boundaries', () => {
  it('keeps heavy views behind dynamic imports', () => {
    for (const target of [
      './components/files/FilesWorkspace',
      './components/files/ProjectHome',
      './components/agents/AITeamHome',
      './components/admin/AdminPanel',
      './components/skills/SkillsBrowser',
    ]) {
      expect(appSource).toContain(`import('${target}')`);
      expect(appSource).not.toContain(`from '${target}'`);
    }
  });

  it('mounts modal chunks only while their surface is open', () => {
    expect(appSource).toContain('{settingsOpen ? <SettingsPanel /> : null}');
    expect(appSource).toContain('{adminOpen ? <AdminPanel open');
    expect(appSource).toContain('{skillsBrowserOpen ? <SkillsBrowser /> : null}');
    expect(appSource).toContain('{promptEditorOpen ? (');
  });

  it('splits top-level routes before rendering the app shell', () => {
    expect(mainSource).toContain("React.lazy(() => import('./App'))");
    expect(mainSource).toContain("import('./components/files/FileViewerPage')");
    expect(mainSource).toContain('<React.Suspense fallback={null}>');
    expect(mainSource).not.toContain("from './components/files/FileViewerPage'");
  });

  it('loads Mermaid only for messages that contain a Mermaid segment', () => {
    expect(richContentSource).toContain("React.lazy(() => import('../chat/MermaidBlock')");
    expect(richContentSource).not.toContain("from '../chat/MermaidBlock'");
    expect(richContentSource).toContain('<LazyBlock type="mermaid">');
  });

  it('does not force feature-only vendors into eager manual chunks', () => {
    expect(viteSource).not.toContain("'vendor-mermaid': ['mermaid']");
    expect(viteSource).not.toContain("'vendor-recharts': ['recharts']");
    expect(viteSource).not.toContain("'vendor-codemirror':");
  });
});
