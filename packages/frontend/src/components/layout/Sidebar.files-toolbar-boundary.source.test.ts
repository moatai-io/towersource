import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sidebar = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
const toolbar = readFileSync(new URL('./SidebarFilesToolbar.tsx', import.meta.url), 'utf8');

describe('Sidebar files toolbar boundary', () => {
  it('loads file toolbar and search result code only inside the Files surface', () => {
    expect(sidebar).toContain("import('./SidebarFilesSurface')");
    expect(toolbar).toContain('export function FilesToolbar(');
    expect(sidebar).not.toContain('function FilesToolbar(');
    expect(sidebar).not.toContain('function SidebarFileSearchResults(');
    expect(toolbar).toContain('export function SidebarFileSearchResults(');
  });
});
