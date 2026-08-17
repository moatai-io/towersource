import { describe, expect, it, vi } from 'vitest';
import { createQuickWebResearchEvalInvoker } from './quick-web-research-eval-runtime.js';
import { QUICK_WEB_RESEARCH_EVAL_PACK } from './quick-web-research.eval-pack.js';

describe('quick-web-research eval runtime adapter',()=>{
  it('passes exact case/run/bundle provenance to the runtime',async()=>{
    const run=vi.fn(async()=>({text:'ok',capabilities:['web.search'],model:'smart'}));
    const invoker=createQuickWebResearchEvalInvoker({run});
    const testCase=QUICK_WEB_RESEARCH_EVAL_PACK.cases[0];
    await expect(invoker.invoke({testCase,runIndex:2,promptBundleHash:'a'.repeat(64)})).resolves.toMatchObject({text:'ok',usedCapabilities:['web.search'],model:'smart',metadata:{caseId:testCase.id,runIndex:2}});
    expect(run).toHaveBeenCalledWith(expect.objectContaining({prompt:testCase.userPrompt,caseId:testCase.id,runIndex:2,promptBundleHash:'a'.repeat(64)}));
  });

  it('injects a fixed simulated tool outcome without changing the original pack',async()=>{
    const run=vi.fn(async()=>({text:'limited',capabilities:['web.fetch'],model:'smart'}));
    const invoker=createQuickWebResearchEvalInvoker({run});
    const testCase=QUICK_WEB_RESEARCH_EVAL_PACK.cases.find((item)=>item.setup?.simulatedFailure)!;
    await invoker.invoke({testCase,runIndex:1,promptBundleHash:'b'.repeat(64)});
    expect(run.mock.calls[0][0].prompt).toContain(testCase.setup!.simulatedFailure!);
    expect(run.mock.calls[0][0].simulatedFailure).toBe(testCase.setup!.simulatedFailure);
    expect(testCase.userPrompt).not.toContain('Evaluation fixture');
  });
});
