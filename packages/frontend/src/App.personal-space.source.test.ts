import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

describe('App Personal Space Viewer integration', () => {
  it('creates and opens a personal note from the Viewer plus button', () => {
    expect(source).toContain("fetch(`${API_BASE}/personal-space/files/create-note`");
    expect(source).toContain("body: JSON.stringify({ content: '' })");
    expect(source).toContain('onClick={() => { void handleCreatePersonalNote(); }}');
    expect(source).toContain("aria-label={t('layout:createBlankPersonalNote')}");
    expect(source).toContain("setContextPanelTab('write')");
    expect(source).not.toContain('<PersonalNotePicker');
    expect(source).not.toContain('>\n                        노트\n');
    expect(source).toContain("aria-label={splitTabId ? 'Viewer 다시 열기' : '빈 개인 노트 만들기'}");
    expect(source).toContain("split: 'right'");
    expect(source).toContain('/personal-space/files/rename');
    expect(source).toContain('renameOpenTabPath(uri, nextUri');
    expect(source).toContain('onRenamePersonalFile={handleRenamePersonalFile}');
    expect(source).toContain("path.startsWith('personal://')");
    expect(source).toContain('void openPersonalFileInViewer(path)');
  });

  it('saves personal virtual URIs through the dedicated owner-scoped API', () => {
    expect(source).toContain("if (path.startsWith('personal://'))");
    expect(source).toContain("fetch(`${API_BASE}/personal-space/files/write`");
    expect(source).toContain('expectedVersion: personalFileVersionsRef.current.get(path)');
    expect(source).toContain('onReload={handleReloadFile}');
    expect(source).not.toContain("saveFile('personal://");
  });
});
