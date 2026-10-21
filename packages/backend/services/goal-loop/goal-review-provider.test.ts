import {it,expect,vi} from 'vitest';
import {createGoalReviewProvider} from './goal-review-provider.js';
import {runAiReviewedGoal} from './ai-review-loop.js';
const opts={systemPrompt:'evaluate',onChunk:()=>{}};
function setup(payload:unknown){const send=vi.fn(async()=>new Response(JSON.stringify(payload)));return {send,call:createGoalReviewProvider({baseUrl:'https://router.example.com',apiKey:'synthetic-test-key',model:'test',fetch:send})};}
it('decodes a completed Responses message',async()=>{const f=setup({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'{}'}]}]});expect(await f.call('data',opts,new AbortController().signal)).toBe('{}');});
it('rejects incomplete output',async()=>{const f=setup({status:'incomplete',output_text:'{}'});await expect(f.call('data',opts,new AbortController().signal)).rejects.toThrow('REVIEW_INCOMPLETE_RESPONSE');});
it('does not expose provider error body',async()=>{const send=vi.fn(async()=>new Response('private provider detail',{status:401}));const call=createGoalReviewProvider({baseUrl:'https://router.example.com',apiKey:'synthetic-test-key',model:'test',fetch:send});await expect(call('data',opts,new AbortController().signal)).rejects.toThrow(/^REVIEW_PROVIDER_HTTP_401$/);});
it('never calls provider when cancelled',async()=>{const f=setup({});const c=new AbortController();c.abort();await expect(f.call('data',opts,c.signal)).rejects.toThrow();expect(f.send).not.toHaveBeenCalled();});
it('bounds response bytes',async()=>{const call=createGoalReviewProvider({baseUrl:'https://router.example.com',apiKey:'synthetic-test-key',model:'test',maxBytes:40,fetch:async()=>new Response('x'.repeat(100))});await expect(call('d',opts,new AbortController().signal)).rejects.toThrow('REVIEW_OUTPUT_LIMIT');});
it('drives revise then pass through the real provider parser with mocked HTTP',async()=>{
 let count=0;const reviews=['revise','pass'];
 const call=createGoalReviewProvider({baseUrl:'https://router.example.com',apiKey:'synthetic-test-key',model:'test',fetch:async()=>{
 const verdict=reviews[count++];return new Response(JSON.stringify({status:'completed',output_text:JSON.stringify({verdict,criteria:[{id:'a',passed:verdict==='pass',reason:'observed'}],requiredChanges:verdict==='pass'?[]:['fix']})}));}});
 const work=vi.fn(async()=>{});
 const result=await runAiReviewedGoal({objective:'fix',criteria:[{id:'a',description:'works'}]}, {work,inspect:async()=>({revision:'r',content:'artifact'}),review:async(g,s,signal)=>call(JSON.stringify({g,s}),opts,signal),allowed:async()=>true,accept:async()=>true,record:async()=>{}},new AbortController().signal,2);
 expect(result).toMatchObject({status:'completed',rounds:2});expect(work).toHaveBeenCalledTimes(2);expect(count).toBe(2);
});
