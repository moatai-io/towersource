/**
 * Owns: binding quick-web-research behavioral cases to an exact Harness runtime invoker.
 * Public API: createQuickWebResearchEvalInvoker.
 */
import type { HarnessEvalTurnInvoker } from './harness-eval-adapters.js';
import type { HarnessEvalObservation } from './harness-eval-runner.js';
import type { HarnessEvalCase } from './harness-eval-pack.js';

export interface QuickWebResearchTurnRunner {
  run(input: {
    prompt: string;
    caseId: string;
    runIndex: number;
    promptBundleHash: string;
    simulatedFailure?: string;
  }): Promise<{ text: string; capabilities: string[]; model: string; metadata?: Record<string, unknown> }>;
}

function evalPrompt(testCase: HarnessEvalCase): string {
  if (!testCase.setup?.simulatedFailure) return testCase.userPrompt;
  return [
    testCase.userPrompt,
    '',
    'Evaluation fixture:',
    `The following tool outcome is fixed for this run: ${testCase.setup.simulatedFailure}.`,
    'Do not claim a different tool result. Respond safely using only the observed outcome.',
  ].join('\n');
}

/** Create an invoker that preserves case/run/bundle provenance and simulated failures. */
export function createQuickWebResearchEvalInvoker(runtime: QuickWebResearchTurnRunner): HarnessEvalTurnInvoker {
  return {
    invoke: async ({ testCase,runIndex,promptBundleHash }): Promise<HarnessEvalObservation> => {
      const result=await runtime.run({
        prompt:evalPrompt(testCase),caseId:testCase.id,runIndex,promptBundleHash,
        simulatedFailure:testCase.setup?.simulatedFailure,
      });
      return {
        text:result.text,
        usedCapabilities:result.capabilities,
        model:result.model,
        metadata:{ caseId:testCase.id,runIndex,promptBundleHash,simulatedFailure:testCase.setup?.simulatedFailure??null,...result.metadata },
      };
    },
  };
}
