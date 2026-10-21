import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './HtmlPreviewSurface.tsx'), 'utf8');

describe('HtmlPreviewSurface Viewer width contract', () => {
  it('observes the actual Viewer container instead of the browser viewport', () => {
    expect(source).toContain('const ro = new ResizeObserver(update)');
    expect(source).toContain('setContainerWidth(el.clientWidth)');
    expect(source).not.toContain('window.innerWidth');
  });

  it('keeps ordinary HTML fluid and fits declared fixed canvases to the Viewer width', () => {
    expect(source).toContain("className={canvas ? 'block border-0 bg-white' : 'h-full w-full border-0 bg-white'}");
    expect(source).toContain('(containerWidth - padding) / canvas.width');
    expect(source).toContain("useState<'fit' | 'custom'>('fit')");
  });
});
