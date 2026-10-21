import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const sidebar = fs.readFileSync(path.resolve(import.meta.dirname, './Sidebar.tsx'), 'utf8');
const filesSurface = fs.readFileSync(path.resolve(import.meta.dirname, './SidebarFilesSurface.tsx'), 'utf8');
const source = `${sidebar}\n${filesSurface}`;
const projectFiles = fs.readFileSync(path.resolve(import.meta.dirname, '../../features/navigation-sidebar/project-files/SidebarProjectFiles.tsx'), 'utf8');
const filesToolbar = fs.readFileSync(path.resolve(import.meta.dirname, './SidebarFilesToolbar.tsx'), 'utf8');

describe('Sidebar current-project file navigation', () => {
  it('derives one current project from the active session or capability context', () => {
    expect(source).toContain("capabilityProjectId || sessions.find((session) => session.id === activeSessionId)?.projectId");
    expect(source).toContain('const activeFileProject =');
    expect(source).toContain('project={activeFileProject}');
    expect(source).toContain('key={activeFileProject.id}');
  });

  it('keeps the file workspace inside the two-column desktop sidebar', () => {
    expect(source).toContain("grid-cols-[176px_minmax(0,1fr)]");
    expect(source).toContain('<SidebarProjectFiles');
    expect(source).not.toContain('전체 파일 관리');
  });

  it('shows mobile recent documents as a quick-file detail above the project explorer', () => {
    expect(source).toContain("t('quickFiles')");
    expect(source).toContain("t('recentDocuments')");
    expect(source).toContain("setMobileQuickFilesView('recent')");
    expect(source).toContain("setMobileQuickFilesView('session')");
    expect(source).toContain('placement="inline"');
    expect(source).toContain("t('projectFiles')");
    expect(source).toContain('mobileDocumentRecents.map');
    expect(source).toContain('setMobileProjectPickerOpen(true)');
    expect(source).toContain("t('searchFileProjects')");
    expect(source).toContain('mobileProjectQuery');
    expect(source).not.toContain("<select value={activeFileProject?.id || ''}");
    expect(source).toContain('onFileClick(document.path)');
    expect(source.indexOf("t('recentDocuments')")).toBeLessThan(source.indexOf("t('projectFiles')"));
  });

  it('reduces mobile Files to a project picker and the open project tree', () => {
    expect(source).toContain("aria-label={t('selectProjectForFiles')}");
    expect(source).toContain("rememberAgentWorkspaceLocation(project.id, 'files')");
    expect(source).toContain('useFileStore.getState().clearSelection()');
    expect(source).toContain('capabilityProjectId || sessions.find');
    expect(source).toContain('mobileQuickFilesView === null && <div className="flex min-h-0 flex-1 flex-col');
    expect(source).toContain("sidebarTab !== 'files'");
    expect(source).toContain("if (sidebarTab !== 'files' || !activeFileProject) return;");
    expect(source).toContain('fileStore.toggleProjectExpanded(activeFileProject.id)');
    expect(source).toContain("mobileQuickFilesView === null && <div className=\"flex min-h-0 flex-1 flex-col space-y-1 px-2\"");
    expect(filesToolbar).toContain("setFileSortMode('modified'); setViewMenuOpen(false)");
    expect(filesToolbar).toContain("<SortMenuItem active={fileSortMode === 'type'}");
  });

  it('renders desktop Folders as a two-column project picker and shared file tree', () => {
    expect(source).toContain("grid-cols-[176px_minmax(0,1fr)]");
    expect(source).toContain("aria-label={t('searchFolderProjects')}");
    expect(source).toContain('folderProjects.map');
    expect(source).toContain('useSettingsStore.getState().setCapabilityProjectId(project.id)');
    expect(source).toContain('<SidebarProjectFiles');
    expect(source).toContain('project={activeFileProject}');
    expect(source).toContain('overflow-x-hidden');
    expect(projectFiles).toContain('setProjectActionMenuOpen((current) => !current)');
    expect(source).not.toContain('전체 파일 관리');
    expect(source).not.toContain("const headerActionBtnClass = 'hidden group-hover/proj:inline-flex");
  });
});
