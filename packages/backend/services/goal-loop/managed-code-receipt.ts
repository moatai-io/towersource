import { randomUUID } from 'node:crypto';
import { transaction } from '../../db/pg-repo.js';
import { criterionHash } from './goal-evidence.js';
import { digestCodeManifest,runApprovedCodeCheck,type ApprovedCodeCheck } from './bounded-code-check.js';
import type { ManagedGoal } from './goal-manager.js';
import type { ManagedGoalCommandGuard } from './managed-goal-service.js';
import type { GoalTransaction } from './goal-manager-store.js';

/** Server-approved checker registration only; not a public arbitrary command tool.
 * Caller must hold an artifact-writer fence spanning this entire operation.
 * Without that external fence digest-before/after cannot exclude ABA changes.
 */
export async function issueManagedCodeReceipt(input:{
 goalId:string;criterionId:string;verifierId:string;spec:ApprovedCodeCheck;
 guard:ManagedGoalCommandGuard;
},signal:AbortSignal,transact:GoalTransaction=transaction) {
 const spec={...input.spec,files:[...input.spec.files],args:[...input.spec.args]};
 const before=await transact(async client=>{
  const rows=await client.query<{record:ManagedGoal}>('SELECT record FROM managed_goals WHERE id=$1 FOR UPDATE',[input.goalId]);
  const goal=rows.rows[0]?.record;
  if(!goal || goal.state.status!=='running'||goal.state.phase!=='check'||!goal.activeExecution
   ||!goal.state.criteria.some(c=>c.id===input.criterionId)||!await input.guard.validate(client,goal,null))throw new Error('CHECKER_DENIED');
  return goal;
 });
 const result=await runApprovedCodeCheck(spec,signal);
 if(result.status==='inconclusive'||!result.artifactDigest||signal.aborted)return null;
 return transact(async client=>{
  const rows=await client.query<{record:ManagedGoal}>('SELECT record FROM managed_goals WHERE id=$1 FOR UPDATE',[input.goalId]);
  const goal=rows.rows[0]?.record;
  if(!goal||goal.version!==before.version||goal.state.revision!==before.state.revision
   ||goal.activeExecution?.rootTurnId!==before.activeExecution?.rootTurnId||signal.aborted
   ||!await input.guard.validate(client,goal,null))return null;
  if(await digestCodeManifest(spec.root,spec.files)!==result.artifactDigest||signal.aborted)return null;
  const criterion=goal.state.criteria.find(c=>c.id===input.criterionId)!;
  const id=randomUUID();
  await client.query(`INSERT INTO managed_goal_evidence(id,goal_id,root_turn_id,criterion_id,criterion_hash,revision,artifact_digest,verifier_id,status)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,goal.id,goal.activeExecution!.rootTurnId,criterion.id,criterionHash(criterion),goal.state.revision,result.artifactDigest,input.verifierId,result.status]);
  return {id,status:result.status,artifactDigest:result.artifactDigest};
 });
}
