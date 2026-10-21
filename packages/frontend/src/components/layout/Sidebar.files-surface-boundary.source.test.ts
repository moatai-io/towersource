import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sidebar = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
const filesSurface = readFileSync(new URL('./SidebarFilesSurface.tsx', import.meta.url), 'utf8');

describe('Sidebar Files surface boundary', () => {
  it('keeps the Files render body behind a tab-only lazy boundary', () => {
    expect(sidebar).toContain("import('./SidebarFilesSurface')");
    expect(sidebar).toContain('<LazySidebarFilesSurface');
    expect(sidebar).not.toContain('data-sidebar-files-root="true"');
    expect(filesSurface).toContain('export function SidebarFilesSurface(');
    expect(filesSurface).toContain('data-sidebar-files-root="true"');
    expect(filesSurface).toContain('aria-label={t(\'searchFolderProjects\')}');
    expect(filesSurface).toContain('<SidebarProjectFiles');
  });
});
