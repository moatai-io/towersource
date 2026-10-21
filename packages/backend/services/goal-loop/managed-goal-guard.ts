import type { ManagedGoalCommandGuard, ManagedGoalAuthority } from './managed-goal-service.js';
import { createGoalDispatchSafety, type GoalDispatchAuthority } from './goal-dispatch-safety.js';

/** Engine-neutral current-turn fence. Receipt verification intentionally denies
 * checks until a production immutable receipt adapter is supplied. */
export function createManagedGoalGuard(scope: ManagedGoalAuthority & {
  sourceUserMessageId: string; ownerToken: string; ownerBootId: string;
  currentTool?: {executionId:string; ownerToken:string};
}, verifyReceipt?: ManagedGoalCommandGuard['validate']): ManagedGoalCommandGuard {
  const bound=Object.freeze({...scope});
  const authority: GoalDispatchAuthority={goalId:bound.goalId,userId:bound.userId,projectId:bound.projectId,
    sessionId:bound.sessionId,userMessageId:bound.sourceUserMessageId};
  return { validate: async (client,goal,command) => {
    if(!bound.ownerToken || !bound.ownerBootId || goal.id!==bound.goalId || goal.userId!==bound.userId
      || goal.sessionId!==bound.sessionId || goal.projectId!==bound.projectId
      || goal.activeExecution?.rootTurnId!==bound.rootTurnId) return false;
    const gate=await createGoalDispatchSafety(authority, command && bound.currentTool ? {...bound.currentTool, rootTurnId:bound.rootTurnId} : undefined)(client,goal);
    // Busy is expected for the executing turn; deny still covers newer input,
    // wait, unsafe effects and ACL loss. All other turns are checked below.
    if(gate==='denied') return false;
    const current=await client.query(`SELECT root_turn_id FROM agent_turns WHERE root_turn_id=$1 AND session_id=$2
      AND state='running' AND owner_token=$3 AND owner_boot_id=$4 AND lease_until>NOW()
      AND waiting_user_started_at IS NULL FOR UPDATE`,[bound.rootTurnId,bound.sessionId,bound.ownerToken,bound.ownerBootId]);
    if(!current.rowCount) return false;
    const other=await client.query(`SELECT root_turn_id FROM agent_turns WHERE session_id=$1 AND root_turn_id<>$2
      AND state IN ('running','waiting_retry','stop_requested') LIMIT 1`,[bound.sessionId,bound.rootTurnId]);
    if(other.rowCount) return false;
    if(command?.action==='check') return verifyReceipt ? verifyReceipt(client,goal,command) : false;
    return command===null || goal.state.status==='running';
  }};
}
