import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const fileOpen = readFileSync(new URL('./useFileOpenActions.ts', import.meta.url), 'utf8');

describe('file open action ownership', () => {
  it('keeps App on hook wiring', () => {
    expect(app).toContain('useFileOpenActions({ token, requestFile, triggerArtifactFlash, t })');
    expect(app).not.toContain('const focusedViewerRequestRef = useRef(0)');
  });

  it('preserves mobile PDF and directory navigation behavior', () => {
    expect(fileOpen).toContain('__towerPdfOpenInProgressUntil');
    expect(fileOpen).toContain('recordMobileDocumentRecent(path, options?.name)');
    expect(fileOpen).toContain('openPdfInBrowserTab(path)');
    expect(fileOpen).toContain("new CustomEvent('tower-reveal-tab-target'");
  });

  it('preserves focused Viewer ordering and failed optimistic tab cleanup', () => {
    expect(fileOpen).toContain('focusedViewerRequestId === focusedViewerRequestRef.current');
    expect(fileOpen).toContain('if (!backgroundViewer && !isLatestFocusedViewerRequest)');
    expect(fileOpen).toContain("stalePlaceholder.content === ''");
    expect(fileOpen).toContain('backgroundSplit: backgroundViewer');
    expect(fileOpen).toContain("if (opened) useFileStore.getState().openSplitTab(opened.id, 'right')");
    expect(fileOpen).toContain("!existingTab && currentViewerTab && !currentViewerTab.modified && currentViewerTab.content === ''");
    expect(fileOpen).toContain('store.closeTab(currentViewerTab.id)');
  });
});


describe('typed file listing navigation', () => {
  it('does not infer folders from extensionless files selected in Agent Home', () => {
    expect(fileOpen).toContain('options?.isDirectory !== false && isDirectoryLikeTowerPath(path)');
    expect(app).toContain("handleFileClick(path, { split: 'right', isDirectory: false })");
  });
  it('returns Agent Home to the AI team surface explicitly', () => {
    expect(app).toMatch(/onBackToTeam=.*setActiveView\('aiTeam'\)/);
  });
});


describe('Agent Home exit affordances', () => {
  it('keeps the home close button visible and exposes the team destination', () => {
    const tabs = readFileSync(new URL('../components/layout/FileTabBar.tsx', import.meta.url), 'utf8');
    const home = readFileSync(new URL('../components/files/ProjectHome.tsx', import.meta.url), 'utf8');
    expect(tabs).toContain("alwaysVisible={s.kind === 'projectFiles'}");
    expect(home).toContain('onClick={onBackToTeam}');
    expect(home).toContain("t('projectHome.backToTeam')");
  });
});
