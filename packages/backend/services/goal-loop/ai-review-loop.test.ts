import {describe,it,expect,vi} from 'vitest';
import {runAiReviewedGoal,parseGoalReview,type ReviewLoopPorts} from './ai-review-loop';
const goal={objective:'Implement requested behavior',criteria:[{id:'C1',description:'Actual route works'}]};
const pass={verdict:'pass',criteria:[{id:'C1',passed:true,reason:'Verified artifact'}],requiredChanges:[]};
const revise={verdict:'revise',criteria:[{id:'C1',passed:false,reason:'Route missing'}],requiredChanges:['Connect route']};
function fixture(){return {work:vi.fn(async()=>{}),inspect:vi.fn(async()=>({revision:'r1',content:'actual files'})),review:vi.fn(async():Promise<unknown>=>pass),allowed:vi.fn(async()=>true),accept:vi.fn(async()=>true),record:vi.fn(async()=>{})} satisfies ReviewLoopPorts;}
describe('AI evaluated completion loop',()=>{
 it('passes evaluator feedback to work and runs again without user prompt',async()=>{
  const p=fixture();p.review.mockResolvedValueOnce(revise).mockResolvedValueOnce(pass);
  expect(await runAiReviewedGoal(goal,p,new AbortController().signal)).toMatchObject({status:'completed',rounds:2});
  expect(p.work).toHaveBeenCalledTimes(2);expect(p.work.mock.calls[1]).toEqual([goal,revise,expect.any(AbortSignal)]);
  expect(p.review.mock.calls[0]).toEqual([goal,{revision:'r1',content:'actual files'},expect.any(AbortSignal)]);
 });
 it('stops on first pass rather than filling the round budget',async()=>{const p=fixture();expect((await runAiReviewedGoal(goal,p,new AbortController().signal,15)).status).toBe('completed');expect(p.work).toHaveBeenCalledTimes(1);});
 it('retries invalid review only and never accepts malformed pass',async()=>{const p=fixture();p.review.mockResolvedValue('PASS');expect(await runAiReviewedGoal(goal,p,new AbortController().signal)).toMatchObject({status:'needs_input',reason:'invalid_review'});expect(p.work).toHaveBeenCalledTimes(1);expect(p.review).toHaveBeenCalledTimes(2);expect(p.accept).not.toHaveBeenCalled();});
 it('requires every criterion and rejects contradictions',()=>{expect(()=>parseGoalReview({...pass,criteria:[]},goal)).toThrow();expect(()=>parseGoalReview({...pass,criteria:[{id:'C1',passed:false,reason:'bad'}]},goal)).toThrow('CONTRADICTORY_PASS');});
 it('blocks stale evaluation',async()=>{const p=fixture();p.inspect.mockResolvedValueOnce({revision:'r1',content:'before'}).mockResolvedValueOnce({revision:'r2',content:'after'});expect(await runAiReviewedGoal(goal,p,new AbortController().signal)).toMatchObject({reason:'artifact_changed_during_review'});expect(p.accept).not.toHaveBeenCalled();});
 it('does not continue after user cancellation in evaluation',async()=>{const p=fixture();const c=new AbortController();p.review.mockImplementation(async()=>{c.abort();return pass;});expect((await runAiReviewedGoal(goal,p,c.signal)).status).toBe('stopped');expect(p.accept).not.toHaveBeenCalled();});
 it('respects evaluator input requests',async()=>{const p=fixture();p.review.mockResolvedValue({...revise,verdict:'needs_input'});expect((await runAiReviewedGoal(goal,p,new AbortController().signal)).status).toBe('needs_input');expect(p.work).toHaveBeenCalledTimes(1);});
 it('bounds nonpassing work and never silently marks complete',async()=>{const p=fixture();p.review.mockResolvedValue(revise);expect(await runAiReviewedGoal(goal,p,new AbortController().signal,2)).toMatchObject({status:'stopped',reason:'round_limit',rounds:2});expect(p.accept).not.toHaveBeenCalled();});
 it('propagates ambiguous worker errors without replay',async()=>{const p=fixture();p.work.mockRejectedValue(new Error('uncertain'));await expect(runAiReviewedGoal(goal,p,new AbortController().signal)).rejects.toThrow('uncertain');expect(p.work).toHaveBeenCalledTimes(1);});
 it('requires atomic final acceptance',async()=>{const p=fixture();p.accept.mockResolvedValue(false);expect(await runAiReviewedGoal(goal,p,new AbortController().signal)).toMatchObject({status:'stopped',reason:'acceptance_denied'});});
});
