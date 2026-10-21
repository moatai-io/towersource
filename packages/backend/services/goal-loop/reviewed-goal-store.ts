import type {PoolClient} from 'pg';
import type {GoalTransaction} from './goal-manager-store.js';
import type {ReviewedGoalOutcome} from './ai-reviewed-goal-runner.js';
import {parseGoalReview,type ReviewGoal,type ReviewSnapshot,type GoalReview} from './ai-review-loop.js';

/** DB implementation for terminal/evaluation persistence. All cooperating stop,
 * admission and ACL writers must use the same transaction fences. Authorization
 * callback is server bound, never model supplied. Does not implement dispatch.
 */
export function createReviewedGoalStore(binding:{id:string;ownerToken:string},transact:GoalTransaction,
 authorize:(client:PoolClient)=>Promise<boolean>) {
 const scope={...binding};
 async function locked<T>(fn:(client:PoolClient,row:any)=>Promise<T>):Promise<T>{
  return transact(async client=>{
   await client.query("SET LOCAL lock_timeout='3s'");
   const rows=await client.query('SELECT * FROM reviewed_goal_runs WHERE id=$1 FOR UPDATE',[scope.id]);
   const row=rows.rows[0];
   if(!row||row.owner_token!==scope.ownerToken||!await authorize(client))throw new Error('REVIEW_RUN_DENIED');
   return fn(client,row);
  });
 }
 return {
  async allowed(){return locked(async(_c,row)=>row.state==='running');},
  async record(event:unknown){await locked(async(client,row)=>{
   if(row.state!=='running')throw new Error('REVIEW_RUN_NOT_RUNNING');
   const encoded=JSON.stringify(event);if(encoded.length>100000||row.events.length>=100)throw new Error('REVIEW_EVENT_LIMIT');
   await client.query('UPDATE reviewed_goal_runs SET events=events || $2::jsonb,updated_at=now() WHERE id=$1',[scope.id,JSON.stringify([event])]);
  });},
  /** inspectFenced must read current artifacts under the caller's writer fence. */
  async accept(snapshot:ReviewSnapshot,review:GoalReview,inspectFenced:(client:PoolClient)=>Promise<ReviewSnapshot>){
   return locked(async(client,row)=>{
    if(row.state!=='running')return false;
    const validated=parseGoalReview(review,row.goal as ReviewGoal);
    if(validated.verdict!=='pass')return false;
    const current=await inspectFenced(client);
    if(current.revision!==snapshot.revision||current.content!==snapshot.content)return false;
    await client.query("UPDATE reviewed_goal_runs SET state='completed',outcome=$2::jsonb,updated_at=now() WHERE id=$1",[scope.id,JSON.stringify({status:'completed',review:validated,revision:snapshot.revision})]);
    return true;
   });
  },
  async finish(outcome:ReviewedGoalOutcome){await locked(async(client,row)=>{
   if(row.state!=='running')return; // Never overwrite accepted completion or a durable stop.
   if(outcome.status==='completed')throw new Error('REVIEW_ACCEPT_REQUIRED');
   await client.query('UPDATE reviewed_goal_runs SET state=$2,outcome=$3::jsonb,updated_at=now() WHERE id=$1',[scope.id,outcome.status,JSON.stringify(outcome)]);
  });},
 };
}
