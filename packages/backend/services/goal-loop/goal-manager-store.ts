import type { PoolClient } from 'pg';
import { transaction } from '../../db/pg-repo.js';
import type { GoalManagerSnapshot, GoalManagerStore, ManagedGoal } from './goal-manager.js';

export type GoalTransaction = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
export interface GoalSettlementObserver {
  /** Read and lock the authoritative session/ACL, terminal, stop/new-input and
   * receipt rows on this transaction. Identity is closure-bound, not model input.
   * Caller must preserve a consistent lock order across all goal writers.
   * No external I/O, no LLM completion assertions. Null denies settlement.
   */
  observe(client: PoolClient, goal: Readonly<ManagedGoal>, terminalId: string): Promise<Omit<GoalManagerSnapshot, 'goal'> | null>;
}

/** Unregistered PostgreSQL adapter. No schema creation or worker startup. */
export function createPostgresGoalManagerStore(observer: GoalSettlementObserver, transact: GoalTransaction = transaction): GoalManagerStore {
  return {
    settleTerminal(goalId, terminalId, decide) {
      return transact(async client => {
        await client.query("SET LOCAL lock_timeout = '3s'");
        await client.query("SET LOCAL statement_timeout = '5s'");
        const loaded = await client.query<{ record: ManagedGoal }>(
          'SELECT record FROM managed_goals WHERE id = $1 FOR UPDATE', [goalId]);
        const goal = loaded.rows[0]?.record;
        if (!goal || goal.id !== goalId) throw new Error('GOAL_NOT_FOUND');
        const observed = await observer.observe(client, structuredClone(goal), terminalId);
        if (!observed || !observed.authorized) return { kind: 'ignore', reason: 'unauthorized' };
        if (observed.terminal.id !== terminalId) throw new Error('GOAL_TERMINAL_MISMATCH');
        const result = decide({ ...observed, goal: structuredClone(goal) });
        if (result.kind === 'ignore') return result;
        const next = result.goal;
        if (next.id !== goal.id || next.version !== goal.version + 1
            || next.userId !== goal.userId || next.projectId !== goal.projectId || next.sessionId !== goal.sessionId) {
          throw new Error('GOAL_SETTLEMENT_SCOPE_MISMATCH');
        }
        // Invalidate an older unconsumed intent before recording the new version.
        await client.query("UPDATE goal_dispatch_intents SET state = 'cancelled' WHERE goal_id = $1 AND state = 'pending'", [goalId]);
        await client.query('UPDATE managed_goals SET record = $2::jsonb, updated_at = now() WHERE id = $1', [goalId, JSON.stringify(next)]);
        if (result.intent) {
          const intent = result.intent;
          if (intent.goalId !== goalId || intent.expectedGoalVersion !== next.version
              || intent.userId !== goal.userId || intent.projectId !== goal.projectId || intent.sessionId !== goal.sessionId) {
            throw new Error('GOAL_INTENT_SCOPE_MISMATCH');
          }
          // Never swallow a conflict: rollback the goal update with the insert.
          await client.query(`INSERT INTO goal_dispatch_intents
            (intent_key, goal_id, expected_goal_version, payload) VALUES ($1, $2, $3, $4::jsonb)`,
          [intent.key, goalId, next.version, JSON.stringify(intent)]);
        }
        return result;
      });
    },
  };
}
