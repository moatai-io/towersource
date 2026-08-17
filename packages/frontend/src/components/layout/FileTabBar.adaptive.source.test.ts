import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tabbarSource = readFileSync(new URL('./FileTabBar.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');

describe('adaptive tab sizing', () => {
  it('lets sortable main tabs share available width between minimum and maximum widths', () => {
    expect(tabbarSource).toContain("tower-main-tab-shell min-w-[5.5rem] max-w-[14rem] flex-[1_1_0] overflow-hidden");
    expect(tabbarSource).toContain('w-full min-w-0 max-w-none flex-1');
    expect(tabbarSource).toContain("min-w-0 flex-1 truncate ${pinned?'not-italic':'italic'}");
    expect(tabbarSource).not.toContain('flex-[0_1_7rem]');
  });

  it('keeps tab actions out of the title flow until hover or keyboard focus', () => {
    expect(tabbarSource).toContain('pointer-events-none absolute inset-y-0 right-0');
    expect(tabbarSource).toContain('group-hover:pointer-events-auto group-hover:opacity-100');
    expect(tabbarSource).toContain('group-focus-within:pointer-events-auto group-focus-within:opacity-100');
    expect(tabbarSource).toContain('group-hover:opacity-100 group-focus-within:opacity-100');
  });

  it('marks optional system-tab metadata so narrow tabs can hide it independently', () => {
    expect(tabbarSource).toContain('tower-main-tab-kind tone-accent tone-pill');
  });

  it('uses the same adaptive sizing and maximum width for Viewer tabs', () => {
    expect(appSource).toContain('className="flex min-w-full items-end gap-0.5"');
    expect(appSource).toContain('className="min-w-[5.5rem] max-w-[14rem] flex-[1_1_0]"');
    expect(appSource).not.toContain('className="min-w-[9.5rem] max-w-[14rem] flex-[0_0_11rem]"');
  });
});

describe('Viewer resize performance', () => {
  it('previews resize with a transform guide and commits width on pointerup', () => {
    expect(appSource).toContain('viewerResizeGuideRef.current.style.transform');
    expect(appSource).toContain('requestAnimationFrame(renderPreview)');
    expect(appSource).toContain('setViewerPaneWidth(nextWidth)');
    expect(appSource).not.toContain('setViewerPaneWidth(next);\n    };\n    const onPointerUp');
  });

  it('blocks iframe pointer capture while the resize gesture is active', () => {
    expect(appSource).toContain('className="fixed inset-0 z-[9998] cursor-col-resize"');
  });
});
