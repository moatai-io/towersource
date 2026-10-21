import type {ReviewedGoalHost} from './ai-reviewed-goal-runner.js';
import type {createReviewedGoalStore} from './reviewed-goal-store.js';
import type {PoolClient} from 'pg';
import type {ReviewSnapshot} from './ai-review-loop.js';

/** Compose the runner's host with a real DB store. Admission remains a mandatory
 * production dependency; this factory cannot create synthetic user messages.
 * authorize in the store must check live ACL, source input and stop policy.
 */
export function createPersistentReviewedGoalHost(input:{
 store:ReturnType<typeof createReviewedGoalStore>;
 admit:ReviewedGoalHost['admit'];
 inspect:ReviewedGoalHost['inspect'];
 inspectFenced(client:PoolClient):Promise<ReviewSnapshot>;
 onMessage:ReviewedGoalHost['onMessage'];
 reviewCall?:ReviewedGoalHost['reviewCall'];
}):ReviewedGoalHost {
 return {
  admit:signal=>input.admit(signal),
  inspect:signal=>input.inspect(signal),
  allowed:async signal=>!signal.aborted&&await input.store.allowed()&&!signal.aborted,
  record:event=>input.store.record(event),
  finish:outcome=>input.store.finish(outcome),
  accept:async(snapshot,review,signal)=>{
   if(signal.aborted)return false;
   return input.store.accept(snapshot,review,async client=>{
    signal.throwIfAborted();const current=await input.inspectFenced(client);signal.throwIfAborted();return current;
   });
  },
  onMessage:message=>input.onMessage(message),
  reviewCall:input.reviewCall?(prompt,opts,signal)=>input.reviewCall!(prompt,opts,signal):undefined,
 };
}
