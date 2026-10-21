import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const appSource = fs.readFileSync(path.resolve(import.meta.dirname, './App.tsx'), 'utf8');
const bootstrapSource = fs.readFileSync(path.resolve(import.meta.dirname, './hooks/useAppBootstrap.ts'), 'utf8');
const startupSource = fs.readFileSync(path.resolve(import.meta.dirname, './hooks/useSessionStartup.ts'), 'utf8');
const mainSource = fs.readFileSync(path.resolve(import.meta.dirname, './main.tsx'), 'utf8');
const richContentSource = fs.readFileSync(path.resolve(import.meta.dirname, './components/shared/RichContent.tsx'), 'utf8');
const viteSource = fs.readFileSync(path.resolve(import.meta.dirname, '../../../vite.config.ts'), 'utf8');
const sessionItemSource = fs.readFileSync(path.resolve(import.meta.dirname, './components/sessions/SessionItem.tsx'), 'utf8');
const sessionPrefetchSource = fs.readFileSync(path.resolve(import.meta.dirname, './features/session-prefetch/prefetchSessionMessages.ts'), 'utf8');

describe('frontend startup session loading boundaries', () => {
  it('does not use the full sessions list as a token validation probe', () => {
    expect(bootstrapSource).toContain('fetchWithRestartTolerantAuth(towerHttpUrl(`/api/auth/check`)');
    expect(bootstrapSource).not.toMatch(/fetchWithRestartTolerantAuth\([^\n]*sessions/);
    expect(appSource).not.toContain('auth 상태 검증 (401만 로그아웃 — 네트워크 에러는 유지)\n        if (status.authEnabled && token) {\n          try {\n            const r = await fetchWithRestartTolerantAuth(`${API_BASE}/sessions`');
  });

  it('loads only the recent startup session window without replacing hydrated project lists', () => {
    expect(startupSource).toContain('const STARTUP_SESSION_LIST_LIMIT = 200;');
    expect(startupSource).toContain('fetchWithRestartTolerantAuth(`${API_BASE}/sessions?limit=${STARTUP_SESSION_LIST_LIMIT}`');
    expect(startupSource).toContain('useSessionStore.getState().setRecentSessions(data, { requestedAt })');
    expect(startupSource).not.toContain('fetchWithRestartTolerantAuth(`${API_BASE}/sessions`, { headers })');
    expect(startupSource).not.toContain('setSessions(next);');
  });

  it('deduplicates startup session list loading for unchanged auth state', () => {
    expect(startupSource).toContain('startupSessionsLoadRef');
    expect(startupSource).toContain('if (sessionsLoaded && startupSessionsLoadRef.current.key === startupKey) return;');
    expect(startupSource).toContain('if (startupSessionsLoadRef.current.inFlight && startupSessionsLoadRef.current.key === startupKey) return;');
  });

  it('can restore the last viewed session outside the recent startup window', () => {
    expect(startupSource).toContain('const session = await response.json();\n            useSessionStore.getState().addSession(session);\n            await onSelectSession(session);');
  });

  it('forces a recent-session reconciliation when a backgrounded mobile tab returns', () => {
    expect(appSource).toContain("refreshSessionList('visibility', { minIntervalMs: 0, force: true })");
    expect(appSource).toContain("refreshSessionList('focus', { minIntervalMs: 15000 })");
  });
});

describe('frontend lazy-loading boundaries', () => {
  it('keeps heavy views behind dynamic imports', () => {
    for (const target of [
      './components/auth/LoginPage',
      './components/sessions/SessionDirectoryPanel',
      './components/agents/AITeamQuickPanel',
      './components/files/FilesWorkspace',
      './components/files/ProjectHome',
      './components/agents/AITeamHome',
      './components/admin/AdminPanel',
      './components/skills/SkillsBrowser',
      './components/schedule/SchedulePanel',
      './components/schedule/ScheduleTabView',
      './components/rooms/AiPanel',
      './components/rooms/RetiredChannelNotice',
      './components/inbox/InboxPanel',
      './components/work/WorkHub',
      './components/favorites/FavoritesPanel',
      './components/uploads/UploadPanel',
      './components/beta/BetaPanel',
    ]) {
      expect(appSource).toContain(`import('${target}')`);
      expect(appSource).not.toContain(`from '${target}'`);
    }
  });

  it('mounts modal chunks only while their surface is open', () => {
    expect(appSource).toContain('{settingsOpen ? <SettingsPanel /> : null}');
    expect(appSource).toContain('{adminOpen ? <AdminPanel open');
    expect(appSource).toContain('{skillsBrowserOpen ? <SkillsBrowser /> : null}');
    expect(appSource).not.toContain('AdministratorParticipation');
    expect(appSource).toContain('{promptEditorOpen ? (');
    expect(appSource).toContain('{aiQuickPanelOpen ? <AITeamQuickPanel');
    expect(appSource).toContain("import { AgentDraftPreview } from './components/files/AgentDraftPreview'");
  });

  it('splits top-level routes before rendering the app shell', () => {
    expect(mainSource).toContain("const loadApp = () => import('./App');");
    expect(mainSource).toContain('React.lazy(() => appStartup ?? loadApp())');
    expect(mainSource).toContain("import('./components/files/FileViewerPage')");
    expect(mainSource).toContain('<React.Suspense fallback={null}>');
    expect(mainSource).not.toContain("from './components/files/FileViewerPage'");
  });

  it('loads Mermaid only for messages that contain a Mermaid segment', () => {
    expect(richContentSource).toContain("React.lazy(() => import('../chat/MermaidBlock')");
    expect(richContentSource).not.toContain("from '../chat/MermaidBlock'");
    expect(richContentSource).toContain('<LazyBlock type="mermaid">');
  });

  it('keeps session hover prefetch out of the App module to avoid a shell cycle', () => {
    expect(sessionItemSource).toContain("from \"../../features/session-prefetch/prefetchSessionMessages\"");
    expect(sessionItemSource).not.toContain('from "../../App"');
    expect(sessionPrefetchSource).toContain('export function prefetchSessionMessages');
    expect(appSource).not.toContain('export function prefetchSessionMessages');
  });

  it('does not force feature-only vendors into eager manual chunks', () => {
    expect(viteSource).not.toContain("'vendor-mermaid': ['mermaid']");
    expect(viteSource).not.toContain("'vendor-recharts': ['recharts']");
    expect(viteSource).not.toContain("'vendor-codemirror':");
  });
});
