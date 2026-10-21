import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sidebar = fs.readFileSync(path.resolve(import.meta.dirname, './Sidebar.tsx'), 'utf8');
const filesSurface = fs.readFileSync(path.resolve(import.meta.dirname, './SidebarFilesSurface.tsx'), 'utf8');
const projectFiles = fs.readFileSync(path.resolve(import.meta.dirname, '../../features/navigation-sidebar/project-files/SidebarProjectFiles.tsx'), 'utf8');
const app = fs.readFileSync(path.resolve(import.meta.dirname, '../../App.tsx'), 'utf8');

const sidebarCallbacks = [
  'onNewSession',
  'onSelectSession',
  'onDeleteSession',
  'onRenameSession',
  'onToggleFavorite',
  'onFileClick',
  'onPersonalFileClick',
  'onPersonalTodosClick',
  'onDirectoryClick',
  'onRequestFileTree',
  'onPinFile',
  'onUnpinFile',
  'onPinClick',
  'onSettingsClick',
  'onPromptClick',
  'onPromptEdit',
  'onPromptDelete',
  'onPromptAdd',
  'onPromptInsert',
  'onNewSessionInFolder',
  'onCollapseSidebar',
] as const;

describe('Sidebar P0 baseline contracts', () => {
  it('keeps the App-facing callback surface stable during extraction', () => {
    const propsBlock = sidebar.slice(sidebar.indexOf('interface SidebarProps'), sidebar.indexOf('export function Sidebar'));
    for (const callback of sidebarCallbacks) expect(propsBlock).toContain(callback);
  });

  it('keeps mobile close/tab transitions in the App wrapper instead of extracted children', () => {
    const mobileSidebar = app.slice(app.indexOf('{sidebarOpen && isMobile'), app.indexOf('{sidebarOpen && !isMobile'));
    expect(mobileSidebar).toContain('setSidebarOpen(false)');
    expect(mobileSidebar).toContain("setMobileTab('ai')");
    expect(mobileSidebar).toContain('onFileClick={(p) => { handleFileClick(p); setSidebarOpen(false); }}');
  });

  it('keeps session window and scroll persistence keys backward compatible', () => {
    expect(sidebar).toContain("sidebar-session-show-all:v1");
    expect(sidebar).toContain("sidebar-session-visible-count:v1");
    expect(sidebar).toContain("sidebar-scroll:v1");
    expect(sidebar).not.toContain("sidebar-agent-session-preview-limit:v1");
    expect(sidebar).toContain('const SESSION_INITIAL_EXPANDED_LIMIT = 50');
    expect(sidebar).toContain('const SESSION_LOAD_BATCH = 50');
  });

  it('keeps Project file expansion and refresh state owned by file-store', () => {
    expect(filesSurface).toContain('<SidebarProjectFiles');
    expect(projectFiles).toContain('s.projectTrees[project.id] || EMPTY_ENTRIES');
    expect(projectFiles).toContain('s.expandedProjects.has(project.id)');
    expect(projectFiles).toContain('s.refreshTrigger');
    expect(projectFiles).toContain('useFileStore.getState().addExpandedPath(dirPath)');
    expect(projectFiles).toContain('useFileStore.getState().removeExpandedPath(dirPath)');
  });

  it('keeps Project file callbacks explicit at the extraction boundary', () => {
    expect(sidebar).toContain('onFileClick={onFileClick}');
    expect(sidebar).toContain('onPinFile={onPinFile}');
    expect(sidebar).toContain('onNewSessionInFolder={onNewSessionInFolder}');
    expect(projectFiles).not.toContain('setActiveView(');
    expect(projectFiles).not.toContain('setSidebarOpen(');
  });
});
