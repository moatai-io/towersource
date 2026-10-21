import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const panel = fs.readFileSync(new URL('./SessionDirectoryPanel.tsx', import.meta.url), 'utf8');
const sidebar = fs.readFileSync(new URL('../layout/Sidebar.tsx', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
const agentHome = fs.readFileSync(new URL('../agents/AgentHomeOverview.tsx', import.meta.url), 'utf8');
const projectHome = fs.readFileSync(new URL('../files/ProjectHome.tsx', import.meta.url), 'utf8');
const header = fs.readFileSync(new URL('../layout/Header.tsx', import.meta.url), 'utf8');

describe('Session directory source contract', () => {
  it('provides search, multi-project/deck filters, metadata filters, and rich sorting', () => {
    expect(panel).toContain("const [query, setQuery]");
    expect(panel).toContain("const [projectIds, setProjectIds]");
    expect(panel).toContain("const [labels, setLabels]");
    expect(panel).toContain("const [owner, setOwner]");
    expect(panel).toContain("const [dateRange, setDateRange]");
    expect(panel).toContain("const [status, setStatus]");
    expect(panel).toContain("const [sort, setSort]");
    expect(panel).toContain('function MultiFilter');
    expect(panel).toContain('labels.has(session.label || DEFAULT_LABEL)');
    expect(panel).toContain("sort === 'turns-desc'");
    expect(panel).not.toContain("sort === 'tokens-desc'");
    expect(panel).toContain("new Intl.DateTimeFormat");
    expect(panel).toContain('<table');
    expect(panel).toContain('className="w-full table-fixed border-collapse text-left"');
    expect(panel).not.toContain('min-w-[980px]');
    expect(panel).not.toContain('min-w-[1060px]');
    expect(panel).toContain('xl:table-cell');
    expect(panel).toContain('lg:table-cell');
    expect(panel).toContain("t('creatorColumn')");
    expect(panel).toContain("t('deckColumn')");
    expect(panel).toContain("t('turnsColumn')");
    expect(panel).not.toContain("t('tokensColumn')");
    expect(panel).toContain('session.ownerUsername');
    expect(panel).toContain('session.participantCount');
    expect(panel).toContain('session.currentUserParticipated !== undefined || session.totalTokens !== undefined');
  });

  it('offers five-session preview, 20-item expansion, and full directory navigation', () => {
    expect(sidebar).toContain('const LABEL_PREVIEW_COUNT = 5');
    expect(sidebar).toContain('const LABEL_LOAD_BATCH = 20');
    expect(sidebar).toContain('sessions.slice(0, visibleCount)');
    expect(sidebar).toContain("t('viewMoreSessions'");
    expect(sidebar).toContain("t('showOnlyRecentSessions'");
    expect(sidebar).toContain('setVisibleCount(LABEL_PREVIEW_COUNT)');
    expect(sidebar).not.toContain('function DefaultDeckOrganizer');
    expect(sidebar).not.toContain("t('organize')");
    expect(sidebar).toContain("new CustomEvent('tower-open-session-directory'");
    expect(app).toContain("window.addEventListener('tower-open-session-directory'");
    expect(app).toContain('<SessionDirectoryPanel sessions={appSessions} projects={projects} mode={sessionDirectory.mode}');
  });

  it('opens the archive in the full directory with archive loading and restore actions', () => {
    expect(header).toContain("new CustomEvent('tower-open-session-directory', { detail: { mode: 'archived' } })");
    expect(header).not.toContain('SessionTrash');
    expect(app).toContain("window.addEventListener('tower-open-session-archive', openArchive)");
    expect(panel).toContain("mode?: DirectoryMode");
    expect(panel).toContain("fetch(towerHttpUrl(`/api/sessions/archived`)");
    expect(panel).toContain("/api/sessions/${encodeURIComponent(session.id)}/restore");
    expect(panel).toContain('setArchivedSessions((current) => current.filter');
    expect(panel).toContain("t('sessionActionsColumn')");
  });

  it('prevents mobile Safari focus zoom and keeps the return header inside the viewport', () => {
    expect(panel).toContain('const isMobile = useSessionStore((state) => state.isMobile);');
    expect(panel).toContain('autoFocus={!isMobile}');
    expect(panel).toContain('text-base text-surface-200');
    expect(panel).toContain('sm:text-sm');
    expect(panel).toContain('<div className="min-w-0"><h1');
    expect(panel).toContain('className="shrink-0 rounded-lg border');
    expect(panel).not.toContain('className="rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-surface-200 placeholder:text-surface-600 sm:col-span-2" autoFocus');
  });

  it('opens all project conversations from the primary Agent home action', () => {
    expect(agentHome).toContain('onOpenAllConversations:()=>void');
    expect(agentHome).toContain("t('agentHome.viewAllConversations')");
    expect(projectHome).toContain("new CustomEvent('tower-open-session-directory', { detail: { projectId: project.id } })");
    expect(panel).toContain('initialLabel === undefined ? new Set()');
  });
});
