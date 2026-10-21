import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const banner = readFileSync('packages/frontend/src/components/common/UpdateBanner.tsx', 'utf8');
describe('UpdateBanner theme contrast', () => {
  it('uses theme-aware readable foreground and surfaces instead of pale accent text', () => {
    expect(banner).toContain('bg-surface-900');
    expect(banner).toContain('text-surface-100');
    expect(banner).not.toContain('text-primary-50');
    expect(banner).not.toContain('dark:');
    expect(banner).toContain('border border-surface-700');
  });
});
