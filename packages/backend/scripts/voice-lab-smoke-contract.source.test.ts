import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const source = readFileSync(new URL('./voice-lab-browser-multi-session-smoke.ts', import.meta.url), 'utf8');
it('does not report media connectivity as semantic roundtrip evidence', () => {
  expect(source).toContain('semantic_roundtrip=not_tested');
  expect(source).toContain('scope=media-connectivity-only');
  expect(source).toContain('result.audio.hasSource && !result.audio.paused');
  expect(source).toContain('AI joined|Receiving audio|Playing');
});
