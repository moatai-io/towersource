import type { ManagedGoalCommandGuard } from './managed-goal-service.js';
import type { GoalSettlementObserver } from './goal-manager-store.js';
import { createGoalDispatchSafety, type GoalDispatchAuthority } from './goal-dispatch-safety.js';

/** Reads real durable terminal rows; receipt completion deliberately fails closed.
 * terminalId is the root ID, which is unique across independently admitted turns.
 * Cooperative admission locks and a completion receipt verifier are still needed.
 */
export function createManagedGoalTerminalObserver(authority:GoalDispatchAuthority, verifyReceipt?:ManagedGoalCommandGuard['validate']):GoalSettlementObserver {
  const bound=Object.freeze({...authority});
  return {observe:async(client,goal,terminalId)=>{
    if(goal.id!==bound.goalId || goal.activeExecution?.rootTurnId!==terminalId) return null;
    const turn=await client.query<{state:string;terminal_at:unknown}>(`SELECT state,terminal_at FROM agent_turns
      WHERE root_turn_id=$1 AND session_id=$2 AND owner_token IS NULL
      AND state IN ('completed','failed','needs_attention','stopped_clean','stopped_forced')
      AND terminal_at IS NOT NULL FOR UPDATE`,[terminalId,bound.sessionId]);
    const row=turn.rows[0];if(!row) return null;
    const gate=await createGoalDispatchSafety(bound)(client,goal);
    if(gate!=='ready') return null;
    return {terminal:{id:terminalId,rootTurnId:terminalId,outcome:row.state==='completed'?'completed':row.state==='needs_attention'?'uncertain':row.state.startsWith('stopped')?'aborted':'failed'},
      authorized:true,userStopped:goal.state.status==='stopped',waitingApproval:false,superseded:false,
      uncertainEffects:false,completionVerified:goal.state.status==='completed' && verifyReceipt
        ? await verifyReceipt(client,goal,{action:'check',outcome:'improved',evidence:goal.state.evidence}) : false};
  }};
}
