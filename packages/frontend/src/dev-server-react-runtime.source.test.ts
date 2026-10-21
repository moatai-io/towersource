import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const scripts = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).scripts as Record<string, string>;

describe('development React runtime', () => {
  it('forces the Vite dev process to use the development JSX runtime, regardless of the caller environment', () => {
    expect(scripts['dev:frontend']).toMatch(/^NODE_ENV=development vite\b/);
  });
});
