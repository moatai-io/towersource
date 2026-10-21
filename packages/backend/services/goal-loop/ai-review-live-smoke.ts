import {createGoalReviewProvider} from './goal-review-provider.js';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runAiReviewedGoal} from './ai-review-loop.js';
import {GOAL_EVALUATOR_INSTRUCTION,buildGoalEvaluationInput,buildGoalWorkInput} from './ai-review-prompts.js';

async function main(){
 if(process.env.GOAL_LIVE_APPROVED!=='1')throw new Error('LIVE_APPROVAL_REQUIRED');
 const url=process.env.LITELLM_BASE_URL;const key=process.env.LITELLM_API_KEY;
 if(!url||!key)throw new Error('LIVE_CONNECTION_MISSING');
 let calls=0;const events:unknown[]=[];let artifact='';
 const provider=createGoalReviewProvider({baseUrl:url,apiKey:key,model:'mini',timeoutMs:60000});
 async function call(system:string,prompt:string){
  if(++calls>6)throw new Error('CALL_LIMIT');
  return provider(prompt,{systemPrompt:system,onChunk:()=>{}},signal);
 }
 const signal=AbortSignal.timeout(180000);
 const result=await runAiReviewedGoal({objective:'Write a concise synthetic office notice in English.',criteria:[{id:'C1',description:'States the fictional office closes Friday at 3 PM.'},{id:'C2',description:'States it reopens Monday at 9 AM.'},{id:'C3',description:'Provides the synthetic contact help@example.com and contains at most 80 words.'}]},{
  work:async(g,f)=>{artifact=await call('Write only the requested notice. Apply evaluator feedback.',buildGoalWorkInput(g,f));},
  inspect:async()=>({revision:createHash('sha256').update(artifact).digest('hex'),content:artifact}),
  review:async(g,s)=>call(GOAL_EVALUATOR_INSTRUCTION,buildGoalEvaluationInput(g,s)),
  allowed:async()=>!signal.aborted,
  accept:async(s)=>!signal.aborted&&s.content===artifact,
  record:async(e)=>{events.push(e);},
 },signal,2);
 await fs.mkdir('work/goals/live-smoke',{recursive:true});
 const output={result,calls,artifact,events,scope:'Actual provider calls; synthetic text only. No Engine.run, DB admission, tool execution or production activation.'};
 await fs.writeFile('work/goals/live-smoke/latest.json',JSON.stringify(output,null,2));
 console.log(JSON.stringify({status:result.status,calls,rounds:result.rounds}));
}
main().catch(e=>{console.error(/^PROVIDER_HTTP_\d+$|^[A-Z_]+$/.test(e.message)?e.message:'LIVE_SMOKE_FAILED');process.exitCode=1;});
