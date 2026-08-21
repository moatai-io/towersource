import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./voice-router.ts', import.meta.url), 'utf8');

describe('voice router API boundary', () => {
  it('feature-gates and authenticates only voice routes so broad /api mounting does not intercept unrelated APIs', () => {
    expect(source).toContain("router.use('/sessions/:sessionId/voice', requireVoiceEnabled, authMiddleware)");
    expect(source).toContain("router.use('/voice/internal', requireVoiceEnabled)");
    expect(source).not.toContain('router.use(authMiddleware)');
    expect(source).not.toContain('router.use(requireVoiceEnabled)');
    expect(source).toContain("router.post('/sessions/:sessionId/voice/start'");
  });
});
