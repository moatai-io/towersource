import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');

describe('Sidebar Personal Space entry', () => {
  it('places My Files at the top of the Files tab', () => {
    const filesBranch = source.indexOf("sidebarTab === 'files'");
    const personalEntry = source.indexOf("t('viewMyFiles')", filesBranch);
    const projectToolbar = source.indexOf('<FilesToolbar', filesBranch);
    expect(personalEntry).toBeGreaterThan(filesBranch);
    expect(personalEntry).toBeLessThan(projectToolbar);
    expect(source).toContain("title={t('openMyTodoInViewer')}");
    expect(source).toContain('onPersonalTodosClick?.()');
    expect(source).toContain('group/personal');
    expect(source).toContain("${personalFilesOpen ? '' : '-rotate-90'}");
  });

  it('keeps membership-scoped projects available to the mobile project picker', () => {
    expect(source).toContain('Always show every project returned by the membership-scoped projects API.');
    expect(source).toContain('return [...allProjects].sort');
    expect(source).toContain('aria-label="파일을 볼 프로젝트 선택"');
    expect(source).toContain('{false && <FilesDropZone projects={allProjects}');
  });

  it('loads owner-scoped personal files and opens them through the provided callback', () => {
    expect(source).toContain("fetch('/api/personal-space/files'");
    expect(source).toContain('onPersonalFileClick?.(file.uri)');
    expect(source).toContain("{t('noPersonalFilesHint')}");
    expect(source).toContain('onContextMenu={(event) =>');
    expect(source).toContain("{t('renamePersonalFile')}");
    expect(source).toContain('/api/personal-space/files/rename');
    expect(source).toContain('/api/personal-space/files/archive');
    expect(source).toContain("{t('moveToArchive')}");
  });
});
