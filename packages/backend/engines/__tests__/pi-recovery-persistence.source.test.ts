import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Pi recovery persistence boundary', () => {
  it('flushes pending assistant inserts before settling a completed recovery FK', () => {
    const source = readFileSync(new URL('../pi-engine.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('const completeRecoveryClaim ='), source.indexOf('const releaseRecoveryClaim ='));
    expect(body).toContain("if (status === 'completed') await flushDbWrites();");
    expect(body.indexOf('await flushDbWrites()')).toBeLessThan(body.indexOf('await completeAgentTurnRecovery('));
  });
});
