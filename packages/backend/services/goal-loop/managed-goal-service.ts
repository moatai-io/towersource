import type { PoolClient } from 'pg';
import { transaction } from '../../db/pg-repo.js';
import { goalToolRequestSchema, type GoalToolService } from './goal-tools.js';
import { transitionGoal } from './goal-transition.js';
import type { ManagedGoal } from './goal-manager.js';
import type { GoalCommand } from './goal-session.js';
import type { GoalTransaction } from './goal-manager-store.js';

export interface ManagedGoalAuthority {
  goalId: string; userId: number; projectId: string; sessionId: string; rootTurnId: string;
}
export interface ManagedGoalCommandGuard {
  /** Recheck current turn lease/token, stop, ACL and revision-bound immutable
   * receipts on this same transaction. No network or model calls. */
  validate(client: PoolClient, goal: Readonly<ManagedGoal>, command: GoalCommand | null): Promise<boolean>;
}
/** Bridges common tools to the persistent goal record used by the manager.
 * Initial goal creation belongs to authorized admission, not this turn adapter.
 */
export function createManagedGoalService(scope: ManagedGoalAuthority, guard: ManagedGoalCommandGuard,
  transact: GoalTransaction = transaction): GoalToolService {
  const bound = Object.freeze({...scope});
  async function locked<T>(fn: (client: PoolClient, goal: ManagedGoal) => Promise<T>): Promise<T> {
    return transact(async client => {
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const rows = await client.query<{record:ManagedGoal}>('SELECT record FROM managed_goals WHERE id=$1 FOR UPDATE',[bound.goalId]);
      const goal=rows.rows[0]?.record;
      if(!goal || goal.id!==bound.goalId || goal.userId!==bound.userId || goal.projectId!==bound.projectId
        || goal.sessionId!==bound.sessionId || goal.activeExecution?.rootTurnId!==bound.rootTurnId) throw new Error('GOAL_SCOPE_DENIED');
      return fn(client,goal);
    });
  }
  return {
    status: () => locked(async(client,goal) => {
      if(!await guard.validate(client,structuredClone(goal),null)) throw new Error('GOAL_ACCESS_DENIED');
      return {version:goal.version,state:goal.state};
    }),
    execute: input => {
      const request=goalToolRequestSchema.parse(input);
      return locked(async(client,goal) => {
        if(!await guard.validate(client,structuredClone(goal),request.command)) throw new Error('GOAL_COMMAND_DENIED');
        const fingerprint=JSON.stringify({rootTurnId:bound.rootTurnId,request});
        const receipts=await client.query<{fingerprint:string}>('SELECT fingerprint FROM managed_goal_commands WHERE goal_id=$1 AND request_id=$2',[goal.id,request.requestId]);
        if(receipts.rowCount) {
          if(receipts.rows[0].fingerprint!==fingerprint) throw new Error('GOAL_IDEMPOTENCY_CONFLICT');
          return {version:goal.version,state:goal.state};
        }
        if(goal.version!==request.expectedVersion) throw new Error('STALE_GOAL_VERSION');
        const count=await client.query<{count:string}>('SELECT count(*)::text AS count FROM managed_goal_commands WHERE goal_id=$1',[goal.id]);
        if(Number(count.rows[0].count)>=64) throw new Error('GOAL_COMMAND_BUDGET');
        const next={...goal,version:goal.version+1,progressVersion:goal.progressVersion+1,
          state:transitionGoal(goal.state,request.command)};
        await client.query('UPDATE managed_goals SET record=$2::jsonb,updated_at=now() WHERE id=$1',[goal.id,JSON.stringify(next)]);
        await client.query('INSERT INTO managed_goal_commands(goal_id,request_id,fingerprint) VALUES($1,$2,$3)',[goal.id,request.requestId,fingerprint]);
        if(next.state.status!=='running') await client.query("UPDATE goal_dispatch_intents SET state='cancelled' WHERE goal_id=$1 AND state='pending'",[goal.id]);
        return {version:next.version,state:next.state};
      });
    },
  };
}
