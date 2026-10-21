import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
describe('concurrent Vite server dependency isolation', () => {
  it('isolates optimizer caches by process so dev and production React cannot mix', () => {
    expect(source).toContain('node_modules/.vite-tower/${process.pid}');
    expect(source).toContain("dedupe: ['react', 'react-dom']");
  });
});
