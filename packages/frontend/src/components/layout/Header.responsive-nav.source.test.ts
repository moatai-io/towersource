import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './Header.tsx'), 'utf8');

describe('Header responsive navigation density', () => {
  it('keeps CJK workspace labels on one line', () => {
    expect(source).toContain('shrink-0 whitespace-nowrap rounded-md');
    expect(source).toContain('tracking-tight whitespace-nowrap');
  });

  it('contains navigation pressure inside a horizontal strip', () => {
    expect(source).toContain('overflow-x-auto rounded-lg bg-surface-850');
    expect(source).toContain('scrollbar-none');
    expect(source).toContain('xl:px-3');
  });

  it('keeps the consolidated app menu trigger and panel above the main surface on mobile', () => {
    expect(source).toContain('<AppMenu');
    expect(source).toContain('relative z-50 h-12');
    expect(source).toContain('w-64 max-h-[calc(100dvh-4.5rem)]');
    expect(source).toContain('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center');
  });
});
