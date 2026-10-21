import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('answer speech boundaries', () => {
  const source = readFileSync(new URL('../../routes/answer-speech-api.ts', import.meta.url), 'utf8');
  it('uses session ACL and gateway authorization instead of direct provider keys', () => {
    expect(source).toContain('canAccessSession');
    expect(source).toContain("apiId: 'text-to-speech'");
    expect(source).not.toContain('ELEVENLABS_API_KEY');
    expect(source).toContain("model_id: 'eleven_v4'");
  });
  it('bounds input, timeout and caching', () => {
    expect(source).toContain('text.length > 5000');
    expect(source).toContain('AbortSignal.timeout(60_000)');
    expect(source).toContain("'Cache-Control', 'no-store'");
  });
});
