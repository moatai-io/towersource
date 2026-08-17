/**
 * Owns: end-to-end behavioral eval orchestration over runtime, grader, and durable store adapters.
 * Public API: executeHarnessEvalRun, comparePersistedHarnessEvalRuns.
 */
import type { HarnessEvalPack } from './harness-eval-pack.js';
import { createHarnessEvalExecutor, createHarnessEvalGrader, type HarnessEvalTurnInvoker } from './harness-eval-adapters.js';
import { runHarnessEvalPack, type HarnessEvalPromotionDecision, type HarnessEvalReport } from './harness-eval-runner.js';
import { completeHarnessEvalRun, failHarnessEvalRun, recordHarnessEvalPromotionDecision, reserveHarnessEvalRun } from './harness-eval-store.js';

/** Run, grade, and persist one complete eval report. */
export async function executeHarnessEvalRun(input: {
  pack: HarnessEvalPack;
  promptBundleHash: string;
  runtimeModel: string;
  graderModel: string;
  invoker: HarnessEvalTurnInvoker;
  createdByUserId?: number;
  graderTimeoutMs?: number;
}): Promise<HarnessEvalReport> {
  const runId = await reserveHarnessEvalRun({
    pack: input.pack,
    promptBundleHash: input.promptBundleHash,
    model: input.runtimeModel,
    createdByUserId: input.createdByUserId,
  });
  try {
    const report = await runHarnessEvalPack({
      pack: input.pack,
      promptBundleHash: input.promptBundleHash,
      runId,
      executor: createHarnessEvalExecutor(input.invoker),
      grader: createHarnessEvalGrader({ model: input.graderModel, timeoutMs: input.graderTimeoutMs }),
    });
    if (report.model !== input.runtimeModel) throw new Error(`Harness eval runtime model drift: expected ${input.runtimeModel}, got ${report.model}`);
    await completeHarnessEvalRun(report);
    return report;
  } catch (error) {
    await failHarnessEvalRun(runId,error);
    throw error;
  }
}

/** Compare two completed reports and append an auditable recommendation. */
export async function comparePersistedHarnessEvalRuns(input: {
  baselineRunId: string;
  candidateRunId: string;
  decidedByUserId?: number;
  maxScoreRegression?: number;
  maxCategoryRegression?: number;
}): Promise<HarnessEvalPromotionDecision> {
  return recordHarnessEvalPromotionDecision(input);
}
