import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './Sidebar.tsx'), 'utf8');
const projectFiles = fs.readFileSync(path.resolve(import.meta.dirname, '../../features/navigation-sidebar/project-files/SidebarProjectFiles.tsx'), 'utf8');

describe('Sidebar current-project file navigation', () => {
  it('derives one current project from the active session or capability context', () => {
    expect(source).toContain("capabilityProjectId || sessions.find((session) => session.id === activeSessionId)?.projectId");
    expect(source).toContain('const activeFileProject =');
    expect(source).toContain('projects={[activeFileProject]}');
    expect(source).toContain('key={activeFileProject.id}');
  });

  it('opens the separate file workspace from the compact desktop toolbar', () => {
    expect(source).toContain("t('openFileWorkspace')");
    expect(source).toContain("setActiveView('projectFiles')");
    expect(source).not.toContain('전체 파일 관리');
  });

  it('shows mobile recent documents as a quick-file detail above the project explorer', () => {
    expect(source).toContain('빠른 파일');
    expect(source).toContain('최근 문서');
    expect(source).toContain("setMobileQuickFilesView('recent')");
    expect(source).toContain("setMobileQuickFilesView('session')");
    expect(source).toContain('placement="inline"');
    expect(source).toContain('프로젝트 파일');
    expect(source).toContain('mobileDocumentRecents.map');
    expect(source).toContain('setMobileProjectPickerOpen(true)');
    expect(source).toContain('파일 프로젝트 검색');
    expect(source).toContain('mobileProjectQuery');
    expect(source).not.toContain("<select value={activeFileProject?.id || ''}");
    expect(source).toContain('onFileClick(document.path)');
    expect(source.indexOf('최근 열어본 문서')).toBeLessThan(source.indexOf('프로젝트 파일'));
  });

  it('reduces mobile Files to a project picker and the open project tree', () => {
    expect(source).toContain('aria-label="파일을 볼 프로젝트 선택"');
    expect(source).toContain("rememberAgentWorkspaceLocation(project.id, 'files')");
    expect(source).toContain('useFileStore.getState().clearSelection()');
    expect(source).toContain('capabilityProjectId || sessions.find');
    expect(source).toContain('<div className="hidden">');
    expect(source).toContain("sidebarTab !== 'files'");
    expect(source).toContain("if (sidebarTab !== 'files' || !activeFileProject) return;");
    expect(source).toContain('fileStore.toggleProjectExpanded(activeFileProject.id)');
    expect(source).toContain('{false && sharedWithMe.length > 0 && (');
    expect(source).toContain('{false && <SelectionToolbar');
    expect(source).toContain('{false && <FilesDropZone');
    expect(source).toContain("setFileSortMode('modified'); setSortMenuOpen(false)");
    expect(source).toContain("!isMobile && <SortMenuItem active={fileSortMode === 'type'}");
  });

  it('renders desktop Folders as a two-column project picker and shared file tree', () => {
    expect(source).toContain("grid-cols-[176px_minmax(0,1fr)]");
    expect(source).toContain('aria-label="폴더 프로젝트 검색"');
    expect(source).toContain('folderProjects.map');
    expect(source).toContain('useSettingsStore.getState().setCapabilityProjectId(project.id)');
    expect(source).toContain('<SidebarProjectFiles');
    expect(source).toContain('onOpenWorkspace={() =>');
    expect(source).toContain("t('openFileWorkspace')");
    expect(source).toContain('overflow-x-hidden');
    expect(projectFiles).toContain('setProjectActionMenuOpen((current) => !current)');
    expect(source).not.toContain('전체 파일 관리');
    expect(source).not.toContain("const headerActionBtnClass = 'hidden group-hover/proj:inline-flex");
  });
});
