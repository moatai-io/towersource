import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Test 3D — Vitest discovers tests under packages/.
 */

const ROOT = path.resolve(import.meta.dirname, '..');

describe('vitest routing', () => {
  it('vitest.config.ts includes packages/** patterns', () => {
    const configPath = path.join(ROOT, 'vitest.config.ts');
    const src = fs.readFileSync(configPath, 'utf-8');
    expect(src).toMatch(/packages\/backend\/\*\*\/\*\.test\.ts/);
    expect(src).toMatch(/packages\/shared\/\*\*\/\*\.test\.ts/);
  });

  it('vitest.config.ts includes __tests__ pattern', () => {
    const configPath = path.join(ROOT, 'vitest.config.ts');
    const src = fs.readFileSync(configPath, 'utf-8');
    expect(src).toMatch(/__tests__\/\*\*\/\*\.test\.ts/);
  });
});
