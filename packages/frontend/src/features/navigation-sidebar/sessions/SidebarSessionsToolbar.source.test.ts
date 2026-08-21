import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const toolbar = fs.readFileSync(path.resolve(import.meta.dirname, './SidebarSessionsToolbar.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.resolve(import.meta.dirname, '../../../components/layout/Sidebar.tsx'), 'utf8');

describe('Sidebar Session toolbar composition contract', () => {
  it('keeps the shell composed through the Session feature module', () => {
    expect(sidebar).toContain("import { SidebarSessionsToolbar } from '../../features/navigation-sidebar/sessions/SidebarSessionsToolbar'");
    expect(sidebar).toContain('<SidebarSessionsToolbar');
    expect(sidebar).not.toContain('function FilterMenuItem(');
    expect(sidebar).not.toContain('function FunnelIcon(');
  });

  it('preserves search, filter labels, copy and styling in the feature module', () => {
    expect(toolbar).toContain('sidebar-sessions-toolbar flex min-w-0');
    expect(toolbar).toContain(`placeholder={t("searchSessions")}`);
    expect(toolbar).toContain(`setKindFilter("agents")`);
    expect(toolbar).toContain(`setKindFilter("runs")`);
    expect(toolbar).toContain(`setKindFilter("external")`);
    expect(toolbar).toContain('t("agentConversations")');
    expect(toolbar).toContain('t("externalDeploymentsWithExtension")');
    expect(toolbar).toContain('title={t("clearSearch")}');
    expect(toolbar).toContain(`toggleFilter("labels")`);
  });

  it('keeps the Session query out of browser and password-manager autofill', () => {
    expect(toolbar).toContain('name="tower-session-search"');
    expect(toolbar).toContain('role="searchbox"');
    expect(toolbar).toContain('aria-label={t("searchSessions")}');
    expect(toolbar).toContain('autoComplete="off"');
    expect(toolbar).toContain('autoCorrect="off"');
    expect(toolbar).toContain('autoCapitalize="none"');
    expect(toolbar).toContain('spellCheck={false}');
    expect(toolbar).toContain('data-1p-ignore');
    expect(toolbar).toContain('data-bwignore');
    expect(toolbar).toContain('data-lpignore="true"');
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
