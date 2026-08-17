import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./ContextPanel.tsx', import.meta.url), 'utf8');

describe('ContextPanel Office preview cache', () => {
  it('keeps only the active and most recent Office preview mounted', () => {
    expect(source).toContain('const MAX_MOUNTED_OFFICE_PREVIEWS = 2');
    expect(source).toContain('const next = prev.filter((key) => key !== activeKey)');
    expect(source).toContain('next.push(activeKey)');
    expect(source).toContain('return next.slice(-MAX_MOUNTED_OFFICE_PREVIEWS)');
  });
});
