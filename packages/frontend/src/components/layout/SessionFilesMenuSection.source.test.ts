import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const header = fs.readFileSync(path.resolve(import.meta.dirname, './Header.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.resolve(import.meta.dirname, './Sidebar.tsx'), 'utf8');
const app = fs.readFileSync(path.resolve(import.meta.dirname, '../../App.tsx'), 'utf8');
const section = fs.readFileSync(path.resolve(import.meta.dirname, './SessionFilesMenuSection.tsx'), 'utf8');

describe('Session files hamburger menu', () => {
  it('keeps one compact second-level entry in the hamburger menu and reuses it in Folders', () => {
    expect(sidebar).not.toContain('SidebarSessionFilesPanel');
    expect(sidebar).toContain('<SessionFilesMenuSection');
    expect(sidebar).toContain('placement="sidebar"');
    expect(header).not.toContain("<MenuSection label={t('thisSessionFiles')} />");
    expect(header).toContain('<SessionFilesMenuSection');
    expect(section).toContain("aria-haspopup=\"dialog\"");
    expect(section).toContain("t('thisSessionFiles')");
    expect(section).toContain('setPanelOpen((current) => !current)');
    expect(section).toContain("placement?: 'menu' | 'sidebar' | 'inline'");
    expect(section).toContain("placement === 'inline'");
    expect(section).toContain("placement === 'sidebar' ? rect.top : menuTop");
  });

  it('keeps file clicks routed through the existing Viewer Pane handler', () => {
    expect(app).toContain('onSessionFileClick={(path) => handleFileClick(path)}');
    expect(header).toContain('onSessionFileClick(path);');
    expect(section).toContain('onClick={() => onFileClick(file.path)}');
  });

  it('loads up to twenty session files and falls back to project files', () => {
    expect(section).toContain('/touched-files?limit=20`');
    expect(section).toContain('/project-recent-files?limit=20`');
    expect(section).toContain('const MAX_VISIBLE_FILES = 20');
    expect(section).toContain("t('recentProjectFilesDescription')");
    expect(section).toContain("document.addEventListener('visibilitychange', pollIfVisible)");
    expect(section).toContain("document.removeEventListener('visibilitychange', pollIfVisible)");
  });

  it('renders the file list in its own scrollable panel', () => {
    expect(section).toContain('overflow-y-auto overscroll-contain');
    expect(section).toContain('[scrollbar-width:thin]');
    expect(section).toContain('window.innerHeight - top - viewportPadding');
    expect(section).toContain('maxHeight: availableHeight');
    expect(section).toContain('px-2 py-1.5');
    expect(section).toContain('text-[12px] leading-4');
    expect(section).not.toContain('{parentPath(file.path)}');
    expect(header).toContain('isMobile={isMobile}');
  });
});
