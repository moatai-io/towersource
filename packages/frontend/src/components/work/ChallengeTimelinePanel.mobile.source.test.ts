import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './ChallengeTimelinePanel.tsx'), 'utf8');

describe('mobile My Work layout', () => {
  it('keeps the mobile work surface locked to the viewport width', () => {
    expect(source).toContain('w-full max-w-full');
    expect(source).toContain('overflow-x-hidden overflow-y-auto overscroll-x-none');
    expect(source).toContain('min-w-0 max-w-full flex-none overflow-x-hidden');
    expect(source).toContain('max-w-full overscroll-x-contain overflow-x-auto');
    expect(source).toContain('md:min-h-0 md:flex-1 md:overflow-auto');
  });

  it('collapses desktop-only explanation and stats on mobile', () => {
    expect(source).toContain('hidden max-w-3xl');
    expect(source).toContain('grid gap-3 md:grid-cols-2');
    expect(source).toContain('md:shrink-0');
  });
});
