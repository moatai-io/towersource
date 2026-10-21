import type { PoolClient } from 'pg';
import type { ManagedGoal } from './goal-manager.js';
import type { GoalCommand } from './goal-session.js';
import { criterionHash } from './goal-evidence.js';

/** Read-only receipt verifier. Digest provider must observe a server-fenced current
 * artifact revision. No public receipt writer/tool exists. Table is draft only.
 */
export function createManagedGoalEvidenceVerifier(binding:{
  trustedVerifierIds:ReadonlySet<string>;
  digest(client:PoolClient,goal:Readonly<ManagedGoal>):Promise<string|null>;
}) {
  const trusted=new Set(binding.trustedVerifierIds);
  return async(client:PoolClient,goal:Readonly<ManagedGoal>,command:GoalCommand|null):Promise<boolean>=>{
    if(command?.action!=='check' || !goal.activeExecution || !['running','completed'].includes(goal.state.status)) return false;
    if(!command.evidence.length) return goal.state.status==='running' && command.outcome==='inconclusive';
    if(new Set(command.evidence.map(e=>e.criterionId)).size!==command.evidence.length) return false;
    const digest=await binding.digest(client,goal);
    if(!digest || !/^[a-f0-9]{64}$/.test(digest)) return false;
    for(const evidence of command.evidence) {
      const criterion=goal.state.criteria.find(c=>c.id===evidence.criterionId);
      if(!criterion || evidence.revision!==goal.state.revision) return false;
      const rows=await client.query(`SELECT * FROM managed_goal_evidence WHERE id=$1 AND goal_id=$2 FOR SHARE`,[evidence.reference,goal.id]);
      const r=rows.rows[0];
      if(!r || r.root_turn_id!==goal.activeExecution.rootTurnId || r.criterion_id!==criterion.id
        || r.criterion_hash!==criterionHash(criterion) || r.revision!==goal.state.revision
        || r.artifact_digest!==digest || !trusted.has(r.verifier_id)
        || r.status==='inconclusive' || evidence.passed!==(r.status==='passed')) return false;
    }
    return true;
  };
}
