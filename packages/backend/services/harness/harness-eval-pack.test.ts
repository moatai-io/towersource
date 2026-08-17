import { describe, expect, it } from 'vitest';
import { summarizeHarnessEvalPack, validateHarnessEvalPack } from './harness-eval-pack.js';
import { QUICK_WEB_RESEARCH_EVAL_PACK } from './quick-web-research.eval-pack.js';
import { QUICK_WEB_RESEARCH_HARNESS } from './quick-web-research-harness.js';

describe('Harness behavioral eval packs', () => {
  it('covers representative behavior and critical failure categories', () => {
    expect(validateHarnessEvalPack(QUICK_WEB_RESEARCH_EVAL_PACK)).toBe(QUICK_WEB_RESEARCH_EVAL_PACK);
    expect(summarizeHarnessEvalPack(QUICK_WEB_RESEARCH_EVAL_PACK)).toEqual({
      caseCount: 12,
      assertionCount: 39,
      hardFailAssertionCount: 11,
      categoryCounts: {
        representative: 4,
        'authority-boundary': 3,
        ambiguity: 2,
        'tool-failure': 2,
        'prompt-injection': 1,
      },
    });
  });

  it('is pinned to the Harness version and only requires registered capabilities', () => {
    expect(`${QUICK_WEB_RESEARCH_EVAL_PACK.harnessId}@${QUICK_WEB_RESEARCH_EVAL_PACK.harnessVersion}`).toBe(`${QUICK_WEB_RESEARCH_HARNESS.id}@${QUICK_WEB_RESEARCH_HARNESS.version}`);
    const requiredCapabilities = QUICK_WEB_RESEARCH_EVAL_PACK.cases.flatMap((testCase) => testCase.assertions)
      .filter((assertion) => assertion.kind === 'required-capability')
      .map((assertion) => assertion.value);
    expect([...new Set(requiredCapabilities)].sort()).toEqual([...QUICK_WEB_RESEARCH_HARNESS.capabilityIds].sort());
  });

  it('rejects weak packs that cannot serve as a promotion gate', () => {
    expect(() => validateHarnessEvalPack({ ...QUICK_WEB_RESEARCH_EVAL_PACK, modelRunsPerCase: 1 })).toThrow('at least two model runs');
    expect(() => validateHarnessEvalPack({ ...QUICK_WEB_RESEARCH_EVAL_PACK, cases: QUICK_WEB_RESEARCH_EVAL_PACK.cases.filter((testCase) => testCase.category !== 'prompt-injection') })).toThrow('missing category prompt-injection');
    expect(() => validateHarnessEvalPack({ ...QUICK_WEB_RESEARCH_EVAL_PACK, cases: QUICK_WEB_RESEARCH_EVAL_PACK.cases.map((testCase) => ({ ...testCase, assertions: testCase.assertions.map((assertion) => ({ ...assertion, severity: 'score' as const })) })) })).toThrow('hard-fail assertion');
  });
});
