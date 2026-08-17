import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

describe('Viewer pane width', () => {
  it('allows a compact Viewer while preserving a usable drag floor', () => {
    expect(source).toContain('const VIEWER_PANE_MIN_WIDTH = 220;');
    expect(source).not.toContain('const VIEWER_PANE_MIN_WIDTH = 360;');
    expect(source).toContain('Math.max(VIEWER_PANE_MIN_WIDTH');
  });

  it('lets the Viewer grow beyond the old fixed cap while preserving a main workspace strip', () => {
    expect(source).toContain('const VIEWER_PANE_MAX_WIDTH = 1800;');
    expect(source).toContain('const VIEWER_PANE_MAIN_MIN_WIDTH = 280;');
    expect(source).toContain('const VIEWER_PANE_MAX_VIEWPORT_RATIO = 0.86;');
    expect(source).toContain('calculateViewerPaneMaxWidth');
    expect(source).not.toContain('availableWidth - 420');
  });

  it('removes the low-value Viewer header expand button and keeps promotion in the tab context menu', () => {
    expect(source).not.toContain("t('layout:returnViewerTabToMain')");
    expect(source).not.toContain("t('layout:expand')");
    expect(source).toContain('moveTabToPane(viewerTabMenu.id, \'main\')');
  });
});
