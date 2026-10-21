import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
const viewerSource = readFileSync(new URL('./ViewerPane.tsx', import.meta.url), 'utf8');

describe('ViewerPane extraction', () => {
  it('keeps App focused on composition and delegates the desktop Viewer surface', () => {
    expect(appSource).toContain("import { ViewerPane } from './components/layout/ViewerPane';");
    expect(appSource).toContain('<ViewerPane');
    expect(appSource).not.toContain('viewerTabMenu');
    expect(appSource).not.toContain('viewerTabbarRef');
  });

  it('preserves compact and wide Viewer sizing constraints', () => {
    expect(viewerSource).toContain('const VIEWER_PANE_MIN_WIDTH = 220;');
    expect(viewerSource).toContain('const VIEWER_PANE_MAX_WIDTH = 1800;');
    expect(viewerSource).toContain('const VIEWER_PANE_MAIN_MIN_WIDTH = 280;');
    expect(viewerSource).toContain('const VIEWER_PANE_MAX_VIEWPORT_RATIO = 0.86;');
    expect(viewerSource).toContain('calculateViewerPaneMaxWidth');
    expect(viewerSource).not.toContain('availableWidth - 420');
  });

  it('owns Viewer tabs, context actions, sharing, and promotion to the main pane', () => {
    expect(viewerSource).toContain('<DndContext');
    expect(viewerSource).toContain('<ViewerTabContextMenu');
    expect(viewerSource).toContain('<ShareModal');
    expect(viewerSource).toContain("moveTabToPane(menu.id, 'main')");
    expect(viewerSource).not.toContain("t('returnViewerTabToMain')");
    expect(viewerSource).not.toContain("t('expand')");
  });

  it('points the Viewer collapse chevron toward the right edge', () => {
    expect(viewerSource).toContain('strokeWidth={1.8} d="M9 5l7 7-7 7"');
    expect(viewerSource).not.toContain('strokeWidth={1.8} d="M15 5l-7 7 7 7"');
  });
});
