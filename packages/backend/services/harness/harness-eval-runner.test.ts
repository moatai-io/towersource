import { describe, expect, it } from 'vitest';
import { compareHarnessEvalReports, harnessEvalPackHash, runHarnessEvalPack, type HarnessEvalReport } from './harness-eval-runner.js';
import { QUICK_WEB_RESEARCH_EVAL_PACK } from './quick-web-research.eval-pack.js';

const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);

function report(overrides: Partial<HarnessEvalReport> = {}): HarnessEvalReport {
  return {
    schemaVersion: 1, runId: 'run', harnessId: 'quick-web-research', harnessVersion: 1, promptBundleHash: hashA, evalPackHash: 'c'.repeat(64),
    model: 'smart', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:01:00.000Z', caseRuns: [],
    summary: { caseRunCount: 36, scorePassed: 84, scoreTotal: 84, scoreRate: 1, hardFailCount: 0, categoryScoreRates: { representative: 1, 'authority-boundary': 1, ambiguity: 1, 'tool-failure': 1, 'prompt-injection': 1 } },
    ...overrides,
  };
}

describe('Harness behavioral eval runner', () => {
  it('executes every case for the contracted number of model runs and grades all assertions', async () => {
    const calls: string[] = [];
    const report = await runHarnessEvalPack({
      pack: QUICK_WEB_RESEARCH_EVAL_PACK, promptBundleHash: hashA, runId: 'deterministic',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      executor: { execute: async ({ testCase, runIndex }) => { calls.push(`${testCase.id}:${runIndex}`); return { text: 'observed', usedCapabilities: ['web.search','web.fetch'], model: 'smart' }; } },
      grader: { grade: async ({ assertion }) => ({ passed: true, reason: `passed ${assertion.id}` }) },
    });
    expect(calls).toHaveLength(QUICK_WEB_RESEARCH_EVAL_PACK.cases.length * QUICK_WEB_RESEARCH_EVAL_PACK.modelRunsPerCase);
    expect(report.summary.caseRunCount).toBe(36);
    expect(report.summary.hardFailCount).toBe(0);
    expect(report.summary.scoreRate).toBe(1);
    expect(report.promptBundleHash).toBe(hashA);
    expect(report.evalPackHash).toBe(harnessEvalPackHash(QUICK_WEB_RESEARCH_EVAL_PACK));
  });

  it('produces a stable pack identity', () => {
    expect(harnessEvalPackHash(QUICK_WEB_RESEARCH_EVAL_PACK)).toMatch(/^[a-f0-9]{64}$/);
    expect(harnessEvalPackHash(QUICK_WEB_RESEARCH_EVAL_PACK)).toBe(harnessEvalPackHash(QUICK_WEB_RESEARCH_EVAL_PACK));
  });

  it('promotes a non-regressing candidate with a distinct Prompt Bundle', () => {
    expect(compareHarnessEvalReports({ baseline: report(), candidate: report({ promptBundleHash: hashB }) })).toMatchObject({ promote: true, reasons: [], scoreDelta: 0 });
  });

  it('blocks hard fails and category regressions regardless of aggregate score', () => {
    const candidate = report({ promptBundleHash: hashB, summary: { ...report().summary, hardFailCount: 1, scoreRate: 1, categoryScoreRates: { ...report().summary.categoryScoreRates, ambiguity: 0.5 } } });
    const decision = compareHarnessEvalReports({ baseline: report(), candidate });
    expect(decision.promote).toBe(false);
    expect(decision.reasons.join(' ')).toContain('hard-fail');
    expect(decision.reasons.join(' ')).toContain('ambiguity');
  });

  it('rejects incomparable reports', () => {
    expect(() => compareHarnessEvalReports({ baseline: report(), candidate: report({ promptBundleHash: hashB, model: 'other' }) })).toThrow('same model');
    expect(() => compareHarnessEvalReports({ baseline: report(), candidate: report({ promptBundleHash: hashB, harnessId: 'other' }) })).toThrow('same Harness identity');
    expect(() => compareHarnessEvalReports({ baseline: report(), candidate: report({ promptBundleHash: hashB, evalPackHash: 'd'.repeat(64) }) })).toThrow('same eval pack');
  });
});
