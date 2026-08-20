import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'AdminPanel.tsx'), 'utf8');

describe('AdminPanel responsive layout contract', () => {
  it('uses compact modal padding and shrink-safe titles on small screens', () => {
    expect(source.match(/px-4 py-3 sm:px-6 sm:py-4/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source.match(/flex-1 overflow-y-auto p-4 sm:p-6/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain('truncate text-[18px] font-bold text-gray-100">{panelTitle}');
    expect(source).toContain("truncate text-[18px] font-bold text-gray-100\">{t('personalCredentials')}");
  });

  it('stacks constrained model and account forms before the small breakpoint', () => {
    expect(source).toContain('grid grid-cols-1 gap-3 sm:grid-cols-2');
    expect(source).toContain('grid grid-cols-1 gap-3 sm:grid-cols-3');
    expect(source).not.toContain('className="grid grid-cols-3 gap-3"');
  });

  it('stacks long account header copy and actions on mobile', () => {
    expect(source).toContain('flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between');
    expect(source).toContain('min-h-10 rounded-lg bg-primary-600');
  });
});
