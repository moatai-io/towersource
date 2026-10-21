import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePiCompactionBudget } from './compaction-budget.js';
afterEach(() => vi.unstubAllEnvs());
describe('Pi compaction budget', () => {
  it('uses the earlier SDK reserve on a 96k model', () => {
    expect(resolvePiCompactionBudget(96_000).thresholdTokens).toBe(48_000);
  });
  it('uses Tower pressure on a 200k model', () => {
    expect(resolvePiCompactionBudget(200_000).thresholdTokens).toBe(144_000);
  });
  it('honors settings and operator overrides', () => {
    vi.stubEnv('PI_PROACTIVE_COMPACTION_PRESSURE', '0.8');
    expect(resolvePiCompactionBudget(200_000, { reserveTokens: 60_000 }).thresholdTokens).toBe(140_000);
    expect(resolvePiCompactionBudget(200_000, { enabled: false }).thresholdTokens).toBe(160_000);
  });
});
it('ignores Tower threshold when proactive execution is disabled', () => {
  vi.stubEnv('PI_TOWER_PROACTIVE_COMPACTION_EXECUTION', '0');
  expect(resolvePiCompactionBudget(200_000).thresholdTokens).toBe(152_000);
});
