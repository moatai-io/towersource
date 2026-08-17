import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./voice-router.ts', import.meta.url), 'utf8');

describe('voice router API boundary', () => {
  it('authenticates only voice routes so broad /api mounting does not intercept health or unrelated APIs', () => {
    expect(source).toContain("router.use('/sessions/:sessionId/voice', authMiddleware)");
    expect(source).not.toContain('router.use(authMiddleware)');
    expect(source).toContain("router.post('/sessions/:sessionId/voice/start'");
  });
});
