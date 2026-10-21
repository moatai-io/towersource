import type {Engine,RunOpts,EngineCallbacks,TowerMessage} from '../../engines/types.js';
import type {ReviewLoopPorts} from './ai-review-loop.js';
import {buildGoalWorkInput,buildGoalEvaluationInput,GOAL_EVALUATOR_INSTRUCTION} from './ai-review-prompts.js';

export interface GoalEngineAdmission {
 sessionId:string; opts:RunOpts; callbacks:EngineCallbacks;
 /** Called even on failure. Owns durable settlement/release, not this adapter. */
 release():Promise<void>;
}
/** Host admits a fresh durable root for every work invocation. No synthetic user
 * message or failed-turn retry. Review uses the engine's stateless, tool-free
 * quickReply path; its API has no cancellation, so aborted replies are discarded
 * after the provider finishes rather than claiming provider execution stopped.
 */
export function createGoalEngineCalls(config:{
 worker:Pick<Engine,'run'|'abort'>;
 evaluator:Pick<Engine,'quickReply'>;
 admit(signal:AbortSignal):Promise<GoalEngineAdmission>;
 onMessage(message:TowerMessage):Promise<void>;
 /** Optional abortable provider, avoiding quickReply's non-cancellable API. */
 reviewCall?:(prompt:string,opts:import('../../engines/types.js').QuickReplyOpts,signal:AbortSignal)=>Promise<string>;
 reviewModel?:string;
 maxReviewChars?:number;
}):Pick<ReviewLoopPorts,'work'|'review'> {
 const max=config.maxReviewChars??100000;
 if(!Number.isInteger(max)||max<1||max>1000000)throw new Error('INVALID_REVIEW_SIZE');
 return {
  work:async(goal,feedback,signal)=>{
   signal.throwIfAborted();
   const admission=await config.admit(signal);
   const abort=()=>config.worker.abort(admission.sessionId);
   try {
    signal.throwIfAborted();
    if(!admission.opts.rootTurnId)throw new Error('GOAL_ENGINE_ROOT_REQUIRED');
    signal.addEventListener('abort',abort,{once:true});
    let completed=false;
    for await(const message of config.worker.run(admission.sessionId,buildGoalWorkInput(goal,feedback),admission.opts,admission.callbacks)) {
     signal.throwIfAborted();
     await config.onMessage(message);
     if(message.type==='engine_done'){
      if(message.outcome!=='completed')throw new Error('GOAL_WORK_NOT_COMPLETED');
      completed=true;
     }
    }
    signal.throwIfAborted();
    if(!completed)throw new Error('GOAL_WORK_TERMINAL_MISSING');
   } finally {signal.removeEventListener('abort',abort);await admission.release();}
  },
  review:async(goal,snapshot,signal)=>{
   signal.throwIfAborted();
   const prompt=buildGoalEvaluationInput(goal,snapshot);
   if(prompt.length>max)throw new Error('GOAL_REVIEW_INPUT_TOO_LARGE');
   const options={model:config.reviewModel,systemPrompt:GOAL_EVALUATOR_INSTRUCTION,onChunk:()=>{}};
   const text=await (config.reviewCall
    ? config.reviewCall(prompt,options,signal)
    : config.evaluator.quickReply(prompt,options));
   signal.throwIfAborted();
   if(text.length>max)throw new Error('GOAL_REVIEW_OUTPUT_TOO_LARGE');
   return text;
  },
 };
}
