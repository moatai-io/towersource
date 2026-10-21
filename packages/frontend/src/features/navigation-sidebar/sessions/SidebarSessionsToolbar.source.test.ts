import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const toolbar = fs.readFileSync(path.resolve(import.meta.dirname, './SidebarSessionsToolbar.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.resolve(import.meta.dirname, '../../../components/layout/Sidebar.tsx'), 'utf8');

describe('Sidebar Session toolbar composition contract', () => {
  it('keeps the shell composed through the Session feature module', () => {
    expect(sidebar).toContain("import { SidebarSessionsToolbar } from '../../features/navigation-sidebar/sessions/SidebarSessionsToolbar'");
    expect(sidebar).toContain('<SidebarSessionsToolbar');
    expect(sidebar).toContain('isMobile={isMobile}');
    expect(sidebar).not.toContain('function FilterMenuItem(');
    expect(sidebar).not.toContain('function FunnelIcon(');
  });

  it('preserves search, filter labels, copy and styling in the feature module', () => {
    expect(toolbar).toContain('sidebar-sessions-toolbar border-b');
    expect(toolbar).toContain(`placeholder={t("searchSessions")}`);
    expect(toolbar).toContain('{!isMobile && <div className="relative min-w-0 flex-1">');
    expect(toolbar).toContain('isMobile ? "w-7"');
    expect(toolbar).toContain(`setKindFilter("agents")`);
    expect(toolbar).toContain(`setKindFilter("runs")`);
    expect(toolbar).toContain(`setKindFilter("external")`);
    expect(toolbar).toContain('t("agentConversations")');
    expect(toolbar).toContain('t("externalDeploymentsWithExtension")');
    expect(toolbar).toContain('title={t("clearSearch")}');
    expect(toolbar).toContain(`toggleFilter("labels")`);
    expect(toolbar).toContain('<span>{t("filters")}</span>');
    expect(toolbar).toContain('t("filterRunning")');
    expect(toolbar).toContain('t("filterAwaiting")');
    expect(toolbar).toContain('t("filterNeedsReview")');
    expect(toolbar).toContain('t("participatedSessions")');
    expect(toolbar).toContain('t("groupByDeck")');
    expect(toolbar).toContain('aria-label={t("activeFilters")}');
    expect(toolbar).toContain('onClick={resetFilters}');
    expect(toolbar).toContain('t("clearFilters")');
  });

  it('keeps the Session query out of browser and password-manager credential autofill', () => {
    expect(toolbar).toContain('name="tower-session-query"');
    expect(toolbar).toContain('role="searchbox"');
    expect(toolbar).toContain('aria-label={t("searchSessions")}');
    // Chrome may ignore "off" for credential heuristics; new-password keeps saved emails out.
    expect(toolbar).toContain('autoComplete="new-password"');
    expect(toolbar).not.toContain('name="tower-session-search"');
    expect(toolbar).not.toContain('autoComplete="off"');
    expect(toolbar).toContain('autoCorrect="off"');
    expect(toolbar).toContain('autoCapitalize="none"');
    expect(toolbar).toContain('spellCheck={false}');
    expect(toolbar).toContain('data-form-type="other"');
    expect(toolbar).toContain('data-1p-ignore="true"');
    expect(toolbar).toContain('data-bwignore="true"');
    expect(toolbar).toContain('data-lpignore="true"');
    expect(toolbar).toContain('data-protonpass-ignore="true"');
  });

  it('wires persistent archive inclusion to both query and local list paths', () => {
    expect(sidebar).toContain("localStorage.getItem('sidebar-search-archived') === 'true'");
    expect(sidebar).toContain("localStorage.setItem('sidebar-search-archived', String(next))");
    expect(sidebar).toContain("if (includeArchived) params.set('includeArchived', '1')");
    expect(sidebar).toContain('combineSidebarSessions(sessions, archivedSessions.sessions, includeArchived)');
    expect(sidebar).toContain('toggleIncludeArchived={toggleIncludeArchived}');
    expect(sidebar).toContain("t('sessionArchiveLoadFailed')");
    expect(sidebar).toContain('onClick={archivedSessions.retry}');
  });

  it('does not take ownership of Session list or App navigation state', () => {
    expect(toolbar).not.toContain('useSessionStore');
    expect(toolbar).not.toContain('streamingSessions');
    expect(toolbar).not.toContain('unreadSessions');
    expect(toolbar).not.toContain('setActiveView(');
    expect(toolbar).not.toContain('setSidebarOpen(');
    expect(toolbar).not.toContain('saveSessionListFilter(');
  });
});
