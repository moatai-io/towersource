import {getEngine} from '../../engines/index.js';
import type {Engine} from '../../engines/types.js';
import {createGoalEngineCalls,type GoalEngineAdmission} from './ai-review-engine-adapter.js';
import {runAiReviewedGoal,type ReviewGoal,type ReviewLoopPorts} from './ai-review-loop.js';
import type {TowerMessage} from '../../engines/types.js';

export type ReviewedGoalOutcome = Awaited<ReturnType<typeof runAiReviewedGoal>>
 | {status:'stopped';reason:'cancelled'|'execution_error';rounds:number};

export interface ReviewedGoalHost extends Pick<ReviewLoopPorts,'inspect'|'allowed'|'accept'|'record'> {
 /** Must admit an independent authorized durable turn, not synthesize user input. */
 /** Persist terminal status under durable ownership. Must be idempotent and
  * must not overwrite an already committed completion from accept(). */
 finish(outcome:ReviewedGoalOutcome):Promise<void>;
 admit(signal:AbortSignal):Promise<GoalEngineAdmission>;
 onMessage(message:TowerMessage):Promise<void>;
 reviewCall?:(prompt:string,opts:import('../../engines/types.js').QuickReplyOpts,signal:AbortSignal)=>Promise<string>;
}
/** Explicit server entry point. Caller supplies closure-authorized host services.
 * This does not bypass admission, install schemas, or register a public route.
 * The evaluator model must be explicitly selected to avoid provider fallback.
 */
export function createAiReviewedGoalRunner(resolve:(name:string)=>Promise<Engine>=getEngine) {
 const active=new Set<string>();
 return async(input:{executionKey:string;goal:ReviewGoal;workerEngine:string;evaluatorEngine:string;
   evaluatorModel:string;maxRounds:number},host:ReviewedGoalHost,signal:AbortSignal)=>{
  if(!input.executionKey.trim()||!input.evaluatorModel.trim()||!input.workerEngine.trim()||!input.evaluatorEngine.trim())
   throw new Error('INVALID_GOAL_RUN_BINDING');
  if(!Number.isInteger(input.maxRounds)||input.maxRounds<1||input.maxRounds>15)throw new Error('INVALID_ROUND_LIMIT');
  // Process-local guard only; durable multi-process ownership remains host duty.
  if(active.has(input.executionKey))throw new Error('GOAL_RUN_ALREADY_ACTIVE');
  active.add(input.executionKey);
  let rounds=0;let enteredLoop=false;let finishing=false;
  try {
   signal.throwIfAborted();
   if(!await host.allowed(signal))throw new Error('GOAL_RUN_DENIED');
   const worker=await resolve(input.workerEngine);
   const evaluator=host.reviewCall ? {quickReply:async()=>{throw new Error('UNEXPECTED_REVIEW_FALLBACK');}} : await resolve(input.evaluatorEngine);
   signal.throwIfAborted();
   const calls=createGoalEngineCalls({worker,evaluator,reviewModel:input.evaluatorModel,
    admit:s=>host.admit(s),onMessage:m=>host.onMessage(m),
    reviewCall:host.reviewCall?(prompt,opts,s)=>host.reviewCall!(prompt,opts,s):undefined});
   enteredLoop=true;
   const outcome=await runAiReviewedGoal(input.goal,{
    ...calls,inspect:s=>host.inspect(s),allowed:s=>host.allowed(s),
    accept:(snapshot,review,s)=>host.accept(snapshot,review,s),record:async e=>{rounds=Math.max(rounds,e.round);await host.record(e);},
   },signal,input.maxRounds);
   finishing=true;
   await host.finish(outcome);
   return outcome;
  }catch(error){
   if(enteredLoop && !finishing){
    await host.finish({status:'stopped',reason:signal.aborted?'cancelled':'execution_error',rounds});
   }
   throw error;
  }finally{active.delete(input.executionKey);}
 };
}
