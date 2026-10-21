import { z } from 'zod';

export const goalReviewSchema = z.object({
  verdict:z.enum(['pass','revise','needs_input']),
  criteria:z.array(z.object({id:z.string().min(1),passed:z.boolean(),reason:z.string().min(1)}).strict()).min(1),
  requiredChanges:z.array(z.string().min(1)),
}).strict();
export type GoalReview=z.infer<typeof goalReviewSchema>;
export interface ReviewGoal {
  objective:string;
  criteria:readonly {id:string;description:string}[];
}
export interface ReviewSnapshot { revision:string; content:string }
export interface ReviewLoopPorts {
  /** Separate worker invocation. Feedback is the last valid review, not a new goal. */
  work(goal:ReviewGoal,feedback:GoalReview|null,signal:AbortSignal):Promise<void>;
  /** Read actual deliverables, not the worker's completion summary. */
  inspect(signal:AbortSignal):Promise<ReviewSnapshot>;
  /** Separate AI invocation with goal, criteria and current deliverables. Return JSON
   * object only. Artifact text is untrusted data, never evaluator instructions. */
  review(goal:ReviewGoal,snapshot:ReviewSnapshot,signal:AbortSignal):Promise<unknown>;
  /** Revalidate authorization, stop, newer input and snapshot freshness. */
  allowed(signal:AbortSignal):Promise<boolean>;
  /** Atomic completion gate: recheck scope/stop/revision and persist outcome.
   * Required for production; may not merely trust a previous allowed() read. */
  accept(snapshot:ReviewSnapshot,review:GoalReview,signal:AbortSignal):Promise<boolean>;
  record(event:{round:number;kind:string;revision?:string;review?:GoalReview}):Promise<void>;
}
export function parseGoalReview(raw:unknown,goal:ReviewGoal):GoalReview {
  const review=goalReviewSchema.parse(typeof raw==='string'?JSON.parse(raw):raw);
  const ids=review.criteria.map(c=>c.id);
  if(new Set(ids).size!==ids.length || ids.length!==goal.criteria.length
    || goal.criteria.some(c=>!ids.includes(c.id))) throw new Error('REVIEW_CRITERIA_MISMATCH');
  if(review.verdict==='pass' && (review.criteria.some(c=>!c.passed)||review.requiredChanges.length)) throw new Error('CONTRADICTORY_PASS');
  if(review.verdict==='revise' && !review.requiredChanges.length) throw new Error('EMPTY_REVISION_FEEDBACK');
  return review;
}
/** Tower-level orchestration, no Pi lifecycle dependency. Round limit is a safety
 * ceiling, never a target. No engine activation occurs by importing this module. */
export async function runAiReviewedGoal(input:ReviewGoal,ports:ReviewLoopPorts,signal:AbortSignal,maxRounds=5) {
  if(!Number.isInteger(maxRounds)||maxRounds<1||maxRounds>15)throw new Error('INVALID_ROUND_LIMIT');
  const goal=structuredClone(input);
  if(!goal.objective.trim()||!goal.criteria.length||new Set(goal.criteria.map(c=>c.id)).size!==goal.criteria.length
    ||goal.criteria.some(c=>!c.id.trim()||!c.description.trim()))throw new Error('INVALID_REVIEW_GOAL');
  let feedback:GoalReview|null=null;
  const allowed=async()=>!signal.aborted&&await ports.allowed(signal)&&!signal.aborted;
  for(let round=1;round<=maxRounds;round++) {
    if(!await allowed())return {status:'stopped' as const,reason:'not_allowed',rounds:round-1};
    await ports.record({round,kind:'working'});
    await ports.work(structuredClone(goal),structuredClone(feedback),signal);
    if(!await allowed())return {status:'stopped' as const,reason:'not_allowed',rounds:round};
    const snapshot=await ports.inspect(signal);
    let review:GoalReview|undefined;
    // One bounded format retry, no repeated work for a malformed evaluator reply.
    for(let attempt=0;attempt<2;attempt++) {
      if(!await allowed())return {status:'stopped' as const,reason:'not_allowed',rounds:round};
      const raw=await ports.review(structuredClone(goal),structuredClone(snapshot),signal);
      try{review=parseGoalReview(raw,goal);break;}catch{
        await ports.record({round,kind:'invalid_review',revision:snapshot.revision});
      }
    }
    if(!review)return {status:'needs_input' as const,reason:'invalid_review',rounds:round};
    if(!await allowed())return {status:'stopped' as const,reason:'not_allowed',rounds:round};
    const current=await ports.inspect(signal);
    if(current.revision!==snapshot.revision || current.content!==snapshot.content)
      return {status:'needs_input' as const,reason:'artifact_changed_during_review',rounds:round};
    await ports.record({round,kind:'reviewed',revision:snapshot.revision,review});
    if(review.verdict==='needs_input')return {status:'needs_input' as const,reason:'review_requires_input',rounds:round,review};
    if(review.verdict==='pass') {
      if(!await allowed()||!await ports.accept(snapshot,review,signal))return {status:'stopped' as const,reason:'acceptance_denied',rounds:round};
      return {status:'completed' as const,rounds:round,review};
    }
    feedback=review;
  }
  return {status:'stopped' as const,reason:'round_limit',rounds:maxRounds};
}
