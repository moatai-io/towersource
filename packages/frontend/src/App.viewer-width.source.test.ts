import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const viewerSource = readFileSync(new URL('./components/layout/ViewerPane.tsx', import.meta.url), 'utf8');

describe('Viewer pane width', () => {
  it('delegates desktop Viewer sizing to the ViewerPane component', () => {
    expect(appSource).toContain("import { ViewerPane } from './components/layout/ViewerPane';");
    expect(appSource).toContain('<ViewerPane');
  });

  it('allows a compact Viewer while preserving a usable drag floor', () => {
    expect(viewerSource).toContain('const VIEWER_PANE_MIN_WIDTH = 220;');
    expect(viewerSource).not.toContain('const VIEWER_PANE_MIN_WIDTH = 360;');
    expect(viewerSource).toContain('Math.max(VIEWER_PANE_MIN_WIDTH');
  });

  it('lets the Viewer grow beyond the old fixed cap while preserving a main workspace strip', () => {
    expect(viewerSource).toContain('const VIEWER_PANE_MAX_WIDTH = 1800;');
    expect(viewerSource).toContain('const VIEWER_PANE_MAIN_MIN_WIDTH = 280;');
    expect(viewerSource).toContain('const VIEWER_PANE_MAX_VIEWPORT_RATIO = 0.86;');
    expect(viewerSource).toContain('calculateViewerPaneMaxWidth');
    expect(viewerSource).not.toContain('availableWidth - 420');
  });

  it('removes the low-value Viewer header expand button and keeps promotion in the tab context menu', () => {
    expect(viewerSource).not.toContain("t('returnViewerTabToMain')");
    expect(viewerSource).not.toContain("t('expand')");
    expect(viewerSource).toContain("moveTabToPane(menu.id, 'main')");
  });
});
