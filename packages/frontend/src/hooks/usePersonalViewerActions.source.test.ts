import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const personal = readFileSync(new URL('./usePersonalViewerActions.ts', import.meta.url), 'utf8');

describe('personal Viewer action ownership', () => {
  it('keeps App on hook wiring and Viewer callback composition', () => {
    expect(app).toContain('usePersonalViewerActions({ token, requestFile, triggerArtifactFlash, t })');
    expect(app).toContain('onCreatePersonalNote={handleCreatePersonalNote}');
    expect(app).toContain('onRenamePersonalFile={handleRenamePersonalFile}');
    expect(app).not.toContain('const personalFileVersionsRef');
  });

  it('preserves version-checked personal note write and rename state', () => {
    expect(personal).toContain('expectedVersion: personalFileVersionsRef.current.get(path)');
    expect(personal).toContain('personalFileVersionsRef.current.set(path, data.version)');
    expect(personal).toContain('renameOpenTabPath(uri, nextUri');
    expect(personal).toContain('previousVersion + 1');
  });

  it('preserves binary content URLs, recents, mobile reveal, and note creation', () => {
    expect(personal).toContain('/personal-space/files/content?uri=');
    expect(personal).toContain('recordRecentPersonalDocument(uri)');
    expect(personal).toContain('recordServerPersonalDocumentOpened(uri)');
    expect(personal).toContain('openMobileContext()');
    expect(personal).toContain("setContextPanelTab('write')");
  });
});
