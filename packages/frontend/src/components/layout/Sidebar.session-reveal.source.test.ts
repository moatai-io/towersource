import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const SIDEBAR_PATH = path.resolve(import.meta.dirname, './Sidebar.tsx');
const FILE_TAB_BAR_PATH = path.resolve(import.meta.dirname, './FileTabBar.tsx');

describe('tab context menu session reveal', () => {
  it('only changes saved filters for an explicit tab reveal, not automatic creation', () => {
    const tabbar = fs.readFileSync(FILE_TAB_BAR_PATH, 'utf-8');
    const sidebar = fs.readFileSync(SIDEBAR_PATH, 'utf-8');

    expect(tabbar).toContain("tower-reveal-session-in-sidebar");
    expect(sidebar).toContain("window.addEventListener('tower-reveal-session-in-sidebar'");
    expect(sidebar).toContain("if (detail.origin === 'created') {");
    expect(sidebar).toMatch(/if \(detail\.origin === 'created'\) \{[\s\S]*?return;\s*\}\s*setSearchQuery\(''\)/);
    expect(sidebar).toContain("setAgentNavScope('work')");
    expect(sidebar).toContain('setSelectedAgentProjectId(session.projectId || null)');
    expect(sidebar).toContain("setMobileAgentPane('detail')");
    expect(sidebar).toContain("saveSessionListFilter('kind', nextKind)");
    expect(sidebar).toContain("saveSessionListFilter('favorites', false)");
  });
});
