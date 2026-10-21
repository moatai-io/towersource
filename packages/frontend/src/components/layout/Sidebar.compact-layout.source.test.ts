import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const sidebarSource = fs.readFileSync(path.resolve(import.meta.dirname, './Sidebar.tsx'), 'utf8');
const agentRailSource = fs.readFileSync(path.resolve(import.meta.dirname, './AgentNavigationRail.tsx'), 'utf8');
const sessionToolbarSource = fs.readFileSync(path.resolve(import.meta.dirname, '../../features/navigation-sidebar/sessions/SidebarSessionsToolbar.tsx'), 'utf8');
const cssSource = fs.readFileSync(path.resolve(import.meta.dirname, '../../index.css'), 'utf8');

describe('Sidebar compact layout', () => {
  it('uses sidebar-owned container queries instead of a larger fixed minimum width', () => {
    expect(sidebarSource).toContain('className="tower-sidebar tower-sidebar-secondary relative w-full min-w-0');
    expect(cssSource).toContain('container-name: tower-sidebar');
    expect(agentRailSource).toContain('agent-nav-rail tower-sidebar-primary relative hidden h-full min-h-0 shrink-0');
    expect(sidebarSource).toContain("localStorage.getItem('sidebar-agent-nav-width:v1')");
    expect(agentRailSource).toContain('style={{ width: visuallyExpanded ? width : 56, marginRight: !expanded && hoverExpanded ? -(width - 56) : 0 }}');
    expect(agentRailSource).toContain('onPointerDown={onResizeStart}');
    expect(cssSource).toContain('@container tower-sidebar (max-width: 390px)');
    expect(cssSource).not.toContain('.agent-nav-rail.is-expanded');
    expect(cssSource).toContain('@container tower-sidebar (max-width: 280px)');
    expect(cssSource).toContain('@container tower-sidebar (max-width: 220px)');
    expect(cssSource).toContain('@container tower-sidebar (max-width: 184px)');
  });

  it('reflows the team ticket rather than crushing Korean labels', () => {
    expect(sidebarSource).toContain('sidebar-team-ticket-body relative mt-3 grid min-w-0');
    expect(sidebarSource).toContain('sidebar-team-ticket-title block truncate whitespace-nowrap');
    expect(sidebarSource).toContain('sidebar-team-ticket-count shrink-0 whitespace-nowrap');
    expect(sidebarSource).toContain('sidebar-team-ticket-cta-label');
    expect(cssSource).toContain('word-break: keep-all');
    expect(cssSource).toContain('.sidebar-team-ticket-description { display: none; }');
    expect(cssSource).toContain('.sidebar-team-ticket-cta-label { display: none; }');
    expect(cssSource).toContain('.sidebar-team-ticket-avatar:nth-child(n + 3) { display: none; }');
    expect(cssSource).toContain('.sidebar-team-ticket-avatar:nth-child(n + 2) { display: none; }');
  });

  it('keeps the sessions toolbar focused on search and filters', () => {
    expect(sessionToolbarSource).toContain('sidebar-sessions-toolbar border-b');
    expect(sessionToolbarSource).toContain('<span>{t("filters")}</span>');
    expect(sidebarSource).not.toContain('sidebar-inbox-button');
    expect(sidebarSource).not.toContain('sidebar-inbox-label whitespace-nowrap');
  });
});
