import { acquireSessionAdmissionLock } from '../agent-turn/session-admission-lock.js';
import type { PoolClient } from 'pg';
import { transaction } from '../../db/pg-repo.js';
import type { GoalDispatchIntent, ManagedGoal } from './goal-manager.js';
import type { GoalTransaction } from './goal-manager-store.js';

export interface GoalTurnAdmissionGateway {
  /** Under this transaction, lock session and recheck ACL, user stop, newer input,
   * approval, uncertain effects and absence of another active execution.
   * ready is permission to admit, NOT permission for external side effects.
   */
  check(client: PoolClient, goal: Readonly<ManagedGoal>): Promise<'ready' | 'busy' | 'denied'>;
  /** Persist a new, independently identified execution request using this SAME
   * client. Unique intent key is the dedupe key. No network/engine calls.
   * Must not register it as a failed-turn retry. Throw to roll back admission.
   */
  enqueue(client: PoolClient, goal: Readonly<ManagedGoal>, intent: Readonly<GoalDispatchIntent>): Promise<string>;
}
type IntentRow = { payload: GoalDispatchIntent; state: string; root_turn_id: string | null; expected_goal_version: number };
export type GoalIntentResult = { status: 'admitted' | 'already_admitted'; rootTurnId: string }
  | { status: 'missing' | 'cancelled' | 'busy' };

/** One durable admission, not a scheduler or engine driver. Caller scans pending
 * keys and calls this; crash after commit is safe to reconcile by returned root.
 */
export function createGoalIntentConsumer(gateway: GoalTurnAdmissionGateway, transact: GoalTransaction = transaction) {
  return {
    async consume(goalId: string, intentKey: string): Promise<GoalIntentResult> {
      if (!goalId.trim() || !intentKey.trim()) throw new Error('INVALID_GOAL_INTENT');
      // Resolve routing only; all authority is rechecked under locks below.
      const sessionId = await transact(async client => {
        const rows = await client.query<{ record: ManagedGoal }>('SELECT record FROM managed_goals WHERE id=$1', [goalId]);
        return rows.rows[0]?.record.sessionId;
      });
      if (!sessionId) return { status: 'missing' };
      const release = await acquireSessionAdmissionLock(sessionId);
      try {
      return await transact(async client => {
        await client.query("SET LOCAL lock_timeout = '3s'");
        await client.query("SET LOCAL statement_timeout = '5s'");
        // Same goal -> intent lock order as terminal settlement.
        const loaded = await client.query<{ record: ManagedGoal }>('SELECT record FROM managed_goals WHERE id=$1 FOR UPDATE', [goalId]);
        const goal = loaded.rows[0]?.record;
        if (!goal) return { status: 'missing' };
        if (goal.id !== goalId || goal.sessionId !== sessionId) throw new Error('GOAL_SCOPE_MISMATCH');
        const rows = await client.query<IntentRow>('SELECT payload,state,root_turn_id,expected_goal_version FROM goal_dispatch_intents WHERE goal_id=$1 AND intent_key=$2 FOR UPDATE', [goalId, intentKey]);
        const row = rows.rows[0];
        if (!row) return { status: 'missing' };
        const intent = row.payload;
        if (intent.key !== intentKey || intent.goalId !== goalId || intent.userId !== goal.userId
          || intent.projectId !== goal.projectId || intent.sessionId !== goal.sessionId
          || intent.expectedGoalVersion !== row.expected_goal_version) throw new Error('GOAL_INTENT_SCOPE_MISMATCH');
        const gate = await gateway.check(client, structuredClone(goal));
        const cancel = async (): Promise<GoalIntentResult> => {
          await client.query("UPDATE goal_dispatch_intents SET state='cancelled' WHERE intent_key=$1 AND state='pending'", [intentKey]);
          return { status: 'cancelled' };
        };
        // Denial never discloses an already admitted execution identity.
        if (gate === 'denied') return cancel();
        if (row.state === 'admitted') {
          if (!row.root_turn_id) throw new Error('GOAL_ADMISSION_CORRUPT');
          return { status: 'already_admitted', rootTurnId: row.root_turn_id };
        }
        if (row.state !== 'pending') return { status: 'cancelled' };
        if (goal.version !== intent.expectedGoalVersion || goal.state.status !== 'running'
          || goal.state.phase !== intent.phase || goal.dispatched >= goal.maxExecutions
          || !Number.isInteger(goal.maxExecutions) || goal.maxExecutions < 1 || goal.maxExecutions > 45
          || (goal.state.phase === 'inspect' && goal.state.cycles >= goal.state.maxCycles)) return cancel();
        if (gate === 'busy' || goal.activeExecution) return { status: 'busy' };
        const rootTurnId = await gateway.enqueue(client, structuredClone(goal), structuredClone(intent));
        if (!rootTurnId.trim()) throw new Error('GOAL_ROOT_REQUIRED');
        const next: ManagedGoal = { ...goal, version: goal.version + 1, dispatched: goal.dispatched + 1,
          activeExecution: { rootTurnId, startProgressVersion: goal.progressVersion } };
        await client.query('UPDATE managed_goals SET record=$2::jsonb,updated_at=now() WHERE id=$1', [goalId, JSON.stringify(next)]);
        await client.query("UPDATE goal_dispatch_intents SET state='admitted',root_turn_id=$2 WHERE intent_key=$1", [intentKey, rootTurnId]);
        return { status: 'admitted', rootTurnId };
      });
      } finally { release(); }
    },
  };
}
