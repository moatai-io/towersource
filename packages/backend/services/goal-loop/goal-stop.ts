import { transaction } from '../../db/pg-repo.js';
import type { ManagedGoal } from './goal-manager.js';
import type { GoalTransaction } from './goal-manager-store.js';

/** Stops future goal dispatch. Does NOT claim that an active engine or external
 * operation has been cancelled; caller must use the existing stop path for that.
 * Scope must originate from authenticated server context, never tool arguments.
 */
export function createGoalStop(scope: { userId: number; projectId: string; sessionId: string }, transact: GoalTransaction = transaction) {
  const bound = Object.freeze({ ...scope });
  return async (goalId: string) => transact(async client => {
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const rows = await client.query<{record: ManagedGoal}>('SELECT record FROM managed_goals WHERE id=$1 FOR UPDATE', [goalId]);
    const goal = rows.rows[0]?.record;
    if (!goal || goal.userId !== bound.userId || goal.sessionId !== bound.sessionId || goal.projectId !== bound.projectId) throw new Error('GOAL_STOP_DENIED');
    const access = await client.query(`SELECT s.id FROM sessions s JOIN projects p ON p.id=s.project_id
      WHERE s.id=$1 AND s.user_id=$2 AND s.project_id=$3 AND COALESCE(s.archived,0)=0
      AND COALESCE(p.archived,0)=0 AND (p.user_id=$2 OR EXISTS
      (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.user_id=$2)) FOR UPDATE OF s`,
    [bound.sessionId, bound.userId, bound.projectId]);
    if (!access.rowCount) throw new Error('GOAL_STOP_DENIED');
    if (goal.state.status !== 'completed' && goal.state.status !== 'stopped') {
      goal.version++;
      goal.state = { ...goal.state, status: 'stopped', reason: 'user_stopped' };
      await client.query('UPDATE managed_goals SET record=$2::jsonb,updated_at=now() WHERE id=$1', [goalId,JSON.stringify(goal)]);
    }
    await client.query("UPDATE goal_dispatch_intents SET state='cancelled' WHERE goal_id=$1 AND state='pending'",[goalId]);
    return { status: goal.state.status, activeRootTurnId: goal.activeExecution?.rootTurnId ?? null,
      activeExecutionCancellationRequired: goal.activeExecution !== null };
  });
}
