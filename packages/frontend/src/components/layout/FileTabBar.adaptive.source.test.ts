import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tabbarSource = readFileSync(new URL('./FileTabBar.tsx', import.meta.url), 'utf8');
const mainTabSource = readFileSync(new URL('./MainTab.tsx', import.meta.url), 'utf8');
const viewerPaneSource = readFileSync(new URL('./ViewerPane.tsx', import.meta.url), 'utf8');

describe('adaptive tab sizing', () => {
  it('lets sortable main tabs share available width between minimum and maximum widths', () => {
    expect(tabbarSource).toContain('tower-main-tab-shell');
    expect(tabbarSource).toContain("min-w-[4.5rem] max-w-[14rem] flex-[1_1_0] overflow-hidden");
    expect(mainTabSource).toContain('w-full min-w-0 max-w-none flex-1');
    expect(tabbarSource).toContain("tower-main-tab-title min-w-0 flex-1 overflow-hidden whitespace-nowrap ${isActive ? 'font-semibold text-gray-100' : 'font-medium'}");
    expect(mainTabSource).toContain('rounded-t-md rounded-b-none');
    expect(mainTabSource).not.toContain('rounded-t-xl rounded-b-none');
    expect(tabbarSource).not.toContain('flex-[0_1_7rem]');
  });

  it('keeps tab actions out of the title flow until hover or keyboard focus', () => {
    expect(mainTabSource).toContain('pointer-events-none absolute inset-y-0 right-0');
    expect(mainTabSource).toContain('group-hover:pointer-events-auto group-hover:opacity-100');
    expect(mainTabSource).toContain('group-focus-within:pointer-events-auto group-focus-within:opacity-100');
    expect(mainTabSource).toContain('group-hover:opacity-100 group-focus-within:opacity-100');
  });

  it('marks optional system-tab metadata so narrow tabs can hide it independently', () => {
    expect(tabbarSource).toContain('tower-main-tab-kind tone-accent tone-pill');
  });

  it('uses the same adaptive sizing and compact chrome for Viewer tabs', () => {
    expect(viewerPaneSource).toContain('className="flex min-w-full items-end gap-0.5"');
    expect(viewerPaneSource).toContain('className="min-w-[5.5rem] max-w-[14rem] flex-[1_1_0]"');
    expect(viewerPaneSource).toContain('tower-viewer-label');
    expect(viewerPaneSource).toContain('tower-viewer-new-note');
    expect(viewerPaneSource).toContain('tower-viewer-collapse');
    expect(viewerPaneSource).not.toContain('className="min-w-[9.5rem] max-w-[14rem] flex-[0_0_11rem]"');
    expect(viewerPaneSource).not.toContain("{t('layout:collapse')} ›");
  });
});

describe('Viewer resize performance', () => {
  it('previews resize with a transform guide and commits width on pointerup', () => {
    expect(viewerPaneSource).toContain('resizeGuideRef.current.style.transform');
    expect(viewerPaneSource).toContain('onPreview: (nextWidth, startWidth) =>');
    expect(viewerPaneSource).toContain('onResizeEnd: (nextWidth) =>');
    expect(viewerPaneSource).toContain('setPaneWidth(nextWidth)');
    expect(viewerPaneSource).not.toContain('onResize: setPaneWidth');
  });

  it('blocks iframe pointer capture while the resize gesture is active', () => {
    expect(viewerPaneSource).toContain('className="fixed inset-0 z-[9998] cursor-col-resize"');
  });
});
