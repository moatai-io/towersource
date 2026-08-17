import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './ChallengeTimelinePanel.tsx'), 'utf8');

describe('AI team activity theme contrast', () => {
  it('uses semantic surface tokens instead of fixed gray text shades', () => {
    expect(source).not.toMatch(/text-gray-\d+/);
    expect(source).toContain('text-surface-100');
    expect(source).toContain('text-surface-500');
    expect(source).toContain('text-surface-600');
  });

  it('pairs status and accent text for light and dark themes', () => {
    expect(source).toContain('text-primary-700 dark:text-primary-300');
    expect(source).toContain('text-amber-700 dark:text-amber-300');
    expect(source).toContain('text-emerald-700 dark:text-emerald-300');
    expect(source).toContain('text-red-700 dark:text-red-300');
  });
});
