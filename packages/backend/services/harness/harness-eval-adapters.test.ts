import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUICK_WEB_RESEARCH_EVAL_PACK } from './quick-web-research.eval-pack.js';

const runUtilityTextTask = vi.fn();
vi.mock('../ai/utility-agent.js', () => ({ runUtilityTextTask }));
const { createHarnessEvalExecutor, createHarnessEvalGrader } = await import('./harness-eval-adapters.js');

const testCase = QUICK_WEB_RESEARCH_EVAL_PACK.cases[0];

describe('Harness eval production adapters', () => {
  beforeEach(() => runUtilityTextTask.mockReset());

  it('normalizes capability observations from the runtime invoker', async () => {
    const executor=createHarnessEvalExecutor({invoke:async()=>({text:'ok',usedCapabilities:['web.search','web.fetch','web.search'],model:'smart'})});
    await expect(executor.execute({testCase,runIndex:1,promptBundleHash:'a'.repeat(64)})).resolves.toMatchObject({usedCapabilities:['web.fetch','web.search'],model:'smart'});
  });

  it('grades capability assertions without an LLM', async () => {
    const grader=createHarnessEvalGrader({model:'grader'});
    await expect(grader.grade({testCase,assertion:testCase.assertions[0],observation:{text:'',usedCapabilities:['web.search'],model:'smart'}})).resolves.toMatchObject({passed:true});
    expect(runUtilityTextTask).not.toHaveBeenCalled();
  });

  it('uses strict JSON grading for behavioral assertions', async () => {
    runUtilityTextTask.mockResolvedValue('{"passed":true,"reason":"explicit evidence"}');
    const grader=createHarnessEvalGrader({model:'grader'});
    await expect(grader.grade({testCase,assertion:testCase.assertions[2],observation:{text:'sources',usedCapabilities:[],model:'smart'}})).resolves.toEqual({passed:true,reason:'explicit evidence'});
  });

  it('fails closed when the grader output is invalid', async () => {
    runUtilityTextTask.mockResolvedValue('not json');
    const grader=createHarnessEvalGrader({model:'grader'});
    await expect(grader.grade({testCase,assertion:testCase.assertions[2],observation:{text:'sources',usedCapabilities:[],model:'smart'}})).rejects.toThrow('invalid JSON');
  });
});
