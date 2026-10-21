import { describe, expect, it } from 'vitest';
import { summarizeHarnessEvalPack, validateHarnessEvalPack } from './harness-eval-pack.js';
import { harnessEvalPackHash, runHarnessEvalPack } from './harness-eval-runner.js';
import { DELEGATED_WORK_COMPLETION_EVAL_PACK as pack } from './delegated-work-completion.eval-pack.js';
import { TOWER_DEFAULT_HARNESS } from './default-harness.js';

// These tests validate criteria and runner plumbing, NOT actual model behavior.
describe('delegated completion behavioral evaluation criteria', () => {
  it('has valid coverage, stable identity and the existing default Harness binding', () => {
    expect(validateHarnessEvalPack(pack)).toBe(pack);
    expect(`${pack.harnessId}@${pack.harnessVersion}`).toBe(`${TOWER_DEFAULT_HARNESS.id}@${TOWER_DEFAULT_HARNESS.version}`);
    expect(harnessEvalPackHash(pack)).toMatch(/^[a-f0-9]{64}$/);
    expect(harnessEvalPackHash(pack)).toBe(harnessEvalPackHash(pack));
    expect(summarizeHarnessEvalPack(pack)).toMatchObject({
      caseCount: 12,
      categoryCounts: { representative: 4, 'authority-boundary': 3, ambiguity: 2, 'tool-failure': 2, 'prompt-injection': 1 },
    });
  });

  it('scores proactive new-work advice separately from completing the original outcome', () => {
    const opportunity = pack.cases.find(testCase => testCase.id === 'new-opportunity-after-completion')!;
    expect(opportunity.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'finish-original', severity: 'score' }),
      expect.objectContaining({ id: 'opinionated-advice', severity: 'score' }),
      expect.objectContaining({ id: 'expand-scope', severity: 'hard-fail' }),
    ]));
    expect(opportunity.assertions.find(assertion => assertion.id === 'opinionated-advice')?.value).toContain('근거·우선순위·효과');
  });

  it('makes early handoff, false completion, unauthorized action and ignored stops hard failures', () => {
    const failures = pack.cases.flatMap(testCase => testCase.assertions).filter(assertion => assertion.severity === 'hard-fail').map(assertion => assertion.id);
    expect(failures).toEqual(expect.arrayContaining([
      'early-handoff', 'false-completion', 'defer-required-test', 'unauthorized-edit',
      'blocked-everything', 'unapproved-deploy', 'blocker-as-recommendation', 'ignore-stop',
      'invent-direction', 'routine-permission', 'defer-recovery', 'claim-save', 'retry-no-progress', 'obey-source',
    ]));
  });

  it('feeds every case to the existing runner and does not average an early handoff away', async () => {
    const executed: string[] = [];
    const report = await runHarnessEvalPack({
      pack, promptBundleHash: 'a'.repeat(64),
      executor: { execute: async ({ testCase }) => {
        executed.push(testCase.id);
        return { text: 'Synthetic runner observation; no model was called.', usedCapabilities: [], model: 'synthetic-test' };
      } },
      grader: { grade: async ({ assertion }) => ({ passed: assertion.id !== 'early-handoff', reason: 'Synthetic grading for runner verification only.' }) },
    });
    expect(executed).toHaveLength(12 * pack.modelRunsPerCase);
    expect(new Set(executed).size).toBe(12);
    expect(report.summary.hardFailCount).toBe(pack.modelRunsPerCase);
    expect(report.summary.scoreRate).toBe(1);
  });
});
