import {it,expect,vi} from 'vitest';
import type {EngineCallbacks,TowerMessage} from '../../engines/types.js';
import {createGoalEngineCalls} from './ai-review-engine-adapter.js';
import {runAiReviewedGoal} from './ai-review-loop.js';
const goal={objective:'fix',criteria:[{id:'a',description:'works'}]};
const pass=JSON.stringify({verdict:'pass',criteria:[{id:'a',passed:true,reason:'checked'}],requiredChanges:[]});
function fixture(outcome:'completed'|'failed'='completed') {
 const release=vi.fn(async()=>{});
 const run=vi.fn(async function*():AsyncGenerator<TowerMessage>{yield {type:'engine_done',sessionId:'s',outcome};});
 const config={worker:{run,abort:vi.fn()},evaluator:{quickReply:vi.fn(async()=>pass)},
  admit:vi.fn(async()=>({sessionId:'s',opts:{cwd:process.cwd(),rootTurnId:'root'},callbacks:{} as EngineCallbacks,release})),onMessage:vi.fn(async()=>{})};
 return {config,release,calls:createGoalEngineCalls(config)};
}
it('composes engine work and separate tool-free evaluation into completion',async()=>{
 const f=fixture();const result=await runAiReviewedGoal(goal,{...f.calls,inspect:async()=>({revision:'1',content:'files'}),allowed:async()=>true,accept:async()=>true,record:async()=>{}},new AbortController().signal);
 expect(result.status).toBe('completed');expect(f.config.worker.run).toHaveBeenCalledTimes(1);expect(f.config.evaluator.quickReply).toHaveBeenCalledTimes(1);expect(f.release).toHaveBeenCalledTimes(1);
 const [,opts]=f.config.evaluator.quickReply.mock.calls[0] as unknown as [string,{systemPrompt:string}];expect(opts.systemPrompt).toContain('untrusted evidence');
});
it('does not review failed execution and releases admission',async()=>{const f=fixture('failed');await expect(f.calls.work(goal,null,new AbortController().signal)).rejects.toThrow('GOAL_WORK_NOT_COMPLETED');expect(f.release).toHaveBeenCalledTimes(1);expect(f.config.evaluator.quickReply).not.toHaveBeenCalled();});
it('discards evaluator output after cancellation without falsely aborting provider',async()=>{const f=fixture();const c=new AbortController();f.config.evaluator.quickReply.mockImplementation(async()=>{c.abort();return pass;});await expect(f.calls.review(goal,{revision:'1',content:'files'},c.signal)).rejects.toThrow();expect(f.config.worker.abort).not.toHaveBeenCalled();});
it('does not send oversized evidence to provider',async()=>{const f=fixture();const calls=createGoalEngineCalls({...f.config,maxReviewChars:10});await expect(calls.review(goal,{revision:'1',content:'files'},new AbortController().signal)).rejects.toThrow('GOAL_REVIEW_INPUT_TOO_LARGE');expect(f.config.evaluator.quickReply).not.toHaveBeenCalled();});
