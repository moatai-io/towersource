import { describe, it, expect } from 'vitest';

/**
 * Native addon load regression guard.
 * Ensures pg can be imported correctly.
 */

describe('native addon loading', () => {
  it('pg 모듈 import 성공', async () => {
    const mod = await import('pg');
    expect(mod.default || mod.Pool || mod.Client).toBeDefined();
  });
});
