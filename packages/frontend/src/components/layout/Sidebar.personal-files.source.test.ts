import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sidebar = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
const filesSurface = readFileSync(new URL('./SidebarFilesSurface.tsx', import.meta.url), 'utf8');
const filesToolbar = readFileSync(new URL('./SidebarFilesToolbar.tsx', import.meta.url), 'utf8');
const source = `${filesSurface}\n${filesToolbar}\n${sidebar}`;

describe('Sidebar project files entry', () => {
  it('does not expose the retired Personal Space plane in Files', () => {
    expect(source).toContain('data-sidebar-files-root="true"');
    expect(filesSurface).not.toContain("t('viewMyFiles')");
    expect(filesSurface).not.toContain('onPersonalTodosClick');
    expect(filesSurface).not.toContain('onPersonalFileClick');
  });

  it('keeps membership-scoped projects available to the mobile project picker', () => {
    expect(sidebar).toContain('Always show every project returned by the membership-scoped projects API.');
    expect(sidebar).toContain('return [...allProjects].sort');
    expect(source).toContain("aria-label={t('selectProjectForFiles')}");
    expect(source).toContain('data-sidebar-file-toolbar="true"');
  });

  it('does not load or mutate Personal Space from the sidebar', () => {
    expect(filesSurface).not.toContain('/api/personal-space');
    expect(filesSurface).not.toContain('personalFiles');
  });
});
