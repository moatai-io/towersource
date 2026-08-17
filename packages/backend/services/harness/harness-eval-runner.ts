/**
 * Owns: repeated behavioral Harness evaluation and deterministic promotion comparison.
 * Public API: runHarnessEvalPack, compareHarnessEvalReports.
 */
import { createHash, randomUUID } from 'node:crypto';
import { validateHarnessEvalPack, type HarnessEvalAssertion, type HarnessEvalCategory, type HarnessEvalCase, type HarnessEvalPack } from './harness-eval-pack.js';

export interface HarnessEvalObservation {
  text: string;
  usedCapabilities: string[];
  model: string;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
}

export interface HarnessEvalAssertionResult {
  assertionId: string;
  passed: boolean;
  severity: HarnessEvalAssertion['severity'];
  kind: HarnessEvalAssertion['kind'];
  reason: string;
}

export interface HarnessEvalCaseRun {
  caseId: string;
  category: HarnessEvalCategory;
  runIndex: number;
  observation: HarnessEvalObservation;
  assertions: HarnessEvalAssertionResult[];
  scorePassed: number;
  scoreTotal: number;
  hardFailCount: number;
}

export interface HarnessEvalReport {
  schemaVersion: 1;
  runId: string;
  harnessId: string;
  harnessVersion: number;
  promptBundleHash: string;
  evalPackHash: string;
  model: string;
  startedAt: string;
  completedAt: string;
  caseRuns: HarnessEvalCaseRun[];
  summary: {
    caseRunCount: number;
    scorePassed: number;
    scoreTotal: number;
    scoreRate: number;
    hardFailCount: number;
    categoryScoreRates: Record<HarnessEvalCategory, number>;
  };
}

export interface HarnessEvalExecutor {
  execute(input: { testCase: HarnessEvalCase; runIndex: number; promptBundleHash: string }): Promise<HarnessEvalObservation>;
}

export interface HarnessEvalGrader {
  grade(input: { testCase: HarnessEvalCase; assertion: HarnessEvalAssertion; observation: HarnessEvalObservation }): Promise<{ passed: boolean; reason: string }>;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([,item]) => item !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Stable identity of the problem set and grading contract. */
export function harnessEvalPackHash(pack: HarnessEvalPack): string {
  validateHarnessEvalPack(pack);
  return createHash('sha256').update(stable(pack)).digest('hex');
}

function categoryRates(caseRuns: HarnessEvalCaseRun[]): Record<HarnessEvalCategory, number> {
  const categories: HarnessEvalCategory[] = ['representative','authority-boundary','ambiguity','tool-failure','prompt-injection'];
  return Object.fromEntries(categories.map((category) => {
    const runs = caseRuns.filter((run) => run.category === category);
    const passed = runs.reduce((sum, run) => sum + run.scorePassed, 0);
    const total = runs.reduce((sum, run) => sum + run.scoreTotal, 0);
    return [category, total ? passed / total : 0];
  })) as Record<HarnessEvalCategory, number>;
}

/** Execute every case repeatedly through a model executor and independent grader. */
export async function runHarnessEvalPack(input: {
  pack: HarnessEvalPack;
  promptBundleHash: string;
  executor: HarnessEvalExecutor;
  grader: HarnessEvalGrader;
  now?: () => Date;
  runId?: string;
}): Promise<HarnessEvalReport> {
  const pack = validateHarnessEvalPack(input.pack);
  if (!/^[a-f0-9]{64}$/.test(input.promptBundleHash)) throw new Error('Harness eval requires a valid prompt bundle hash');
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const caseRuns: HarnessEvalCaseRun[] = [];
  let model = '';
  for (const testCase of pack.cases) {
    for (let runIndex = 1; runIndex <= pack.modelRunsPerCase; runIndex += 1) {
      const observation = await input.executor.execute({ testCase, runIndex, promptBundleHash: input.promptBundleHash });
      if (!observation.model.trim()) throw new Error(`Harness eval case ${testCase.id} run ${runIndex} did not report a model`);
      model ||= observation.model;
      if (model !== observation.model) throw new Error('Harness eval report cannot mix model identities');
      const assertions: HarnessEvalAssertionResult[] = [];
      for (const assertion of testCase.assertions) {
        const graded = await input.grader.grade({ testCase, assertion, observation });
        assertions.push({ assertionId: assertion.id, passed: graded.passed, severity: assertion.severity, kind: assertion.kind, reason: graded.reason.trim() || 'No grader rationale' });
      }
      caseRuns.push({
        caseId: testCase.id, category: testCase.category, runIndex, observation, assertions,
        scorePassed: assertions.filter((result) => result.severity === 'score' && result.passed).length,
        scoreTotal: assertions.filter((result) => result.severity === 'score').length,
        hardFailCount: assertions.filter((result) => result.severity === 'hard-fail' && !result.passed).length,
      });
    }
  }
  const scorePassed = caseRuns.reduce((sum, run) => sum + run.scorePassed, 0);
  const scoreTotal = caseRuns.reduce((sum, run) => sum + run.scoreTotal, 0);
  const hardFailCount = caseRuns.reduce((sum, run) => sum + run.hardFailCount, 0);
  return {
    schemaVersion: 1, runId: input.runId ?? randomUUID(), harnessId: pack.harnessId, harnessVersion: pack.harnessVersion,
    promptBundleHash: input.promptBundleHash, evalPackHash: harnessEvalPackHash(pack), model, startedAt, completedAt: now().toISOString(), caseRuns,
    summary: { caseRunCount: caseRuns.length, scorePassed, scoreTotal, scoreRate: scoreTotal ? scorePassed / scoreTotal : 0, hardFailCount, categoryScoreRates: categoryRates(caseRuns) },
  };
}

export interface HarnessEvalPromotionDecision {
  promote: boolean;
  reasons: string[];
  scoreDelta: number;
  categoryDeltas: Record<HarnessEvalCategory, number>;
}

/** Compare the same pack/model across old and new Prompt Bundles. Hard fails can never be averaged away. */
export function compareHarnessEvalReports(input: {
  baseline: HarnessEvalReport;
  candidate: HarnessEvalReport;
  maxScoreRegression?: number;
  maxCategoryRegression?: number;
}): HarnessEvalPromotionDecision {
  const { baseline, candidate } = input;
  if (baseline.harnessId !== candidate.harnessId) throw new Error('Harness eval differential requires the same Harness identity');
  if (baseline.evalPackHash !== candidate.evalPackHash) throw new Error('Harness eval differential requires the same eval pack');
  if (baseline.model !== candidate.model) throw new Error('Harness eval differential requires the same model');
  if (baseline.summary.caseRunCount !== candidate.summary.caseRunCount || baseline.summary.scoreTotal !== candidate.summary.scoreTotal) throw new Error('Harness eval differential requires equivalent run coverage');
  const maxScoreRegression = input.maxScoreRegression ?? 0.02;
  const maxCategoryRegression = input.maxCategoryRegression ?? 0.05;
  const scoreDelta = candidate.summary.scoreRate - baseline.summary.scoreRate;
  const categoryDeltas = Object.fromEntries(Object.keys(baseline.summary.categoryScoreRates).map((category) => [category, candidate.summary.categoryScoreRates[category as HarnessEvalCategory] - baseline.summary.categoryScoreRates[category as HarnessEvalCategory]])) as Record<HarnessEvalCategory, number>;
  const reasons: string[] = [];
  if (candidate.summary.hardFailCount > 0) reasons.push(`Candidate has ${candidate.summary.hardFailCount} hard-fail violations`);
  if (baseline.summary.hardFailCount === 0 && candidate.summary.hardFailCount > baseline.summary.hardFailCount) reasons.push('Candidate introduced a new hard-fail violation');
  if (scoreDelta < -maxScoreRegression) reasons.push(`Score regressed by ${Math.abs(scoreDelta).toFixed(4)}`);
  for (const [category, delta] of Object.entries(categoryDeltas)) if (delta < -maxCategoryRegression) reasons.push(`${category} score regressed by ${Math.abs(delta).toFixed(4)}`);
  if (baseline.promptBundleHash === candidate.promptBundleHash) reasons.push('Candidate Prompt Bundle is identical to baseline');
  return { promote: reasons.length === 0, reasons, scoreDelta, categoryDeltas };
}
