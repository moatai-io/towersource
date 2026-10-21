import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { GoalDispatchIntent, ManagedGoal } from './goal-manager.js';
import { createGoalDispatchSafety, type GoalDispatchAuthority } from './goal-dispatch-safety.js';

/** Durable internal provenance, not a messages(role=user) record. This request ID
 * must be explicitly adapted to the future turn admission contract: current
 * agent_turns.root_turn_id references messages and cannot consume it directly.
 */
export function createGoalInternalRequestGateway(authority: GoalDispatchAuthority) {
  const bound = Object.freeze({ ...authority });
  const check = createGoalDispatchSafety(bound);
  return {
    check,
    async persist(client: PoolClient, goal: Readonly<ManagedGoal>, intent: Readonly<GoalDispatchIntent>) {
      // Recheck even if invoked independently of the consumer; same transaction.
      if (await check(client, goal) !== 'ready') throw new Error('GOAL_INTERNAL_ADMISSION_DENIED');
      if (intent.goalId !== goal.id || intent.userId !== goal.userId || intent.sessionId !== goal.sessionId
        || intent.projectId !== goal.projectId || intent.expectedGoalVersion !== goal.version
        || intent.phase !== goal.state.phase || goal.state.status !== 'running') throw new Error('GOAL_INTERNAL_SCOPE_MISMATCH');
      const requestId = randomUUID();
      await client.query(`INSERT INTO goal_internal_requests
        (id,intent_key,goal_id,session_id,project_id,user_id,source_user_message_id,phase,goal_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [requestId, intent.key, goal.id, goal.sessionId, goal.projectId, goal.userId,
        bound.userMessageId, intent.phase, goal.version]);
      return { status: 'persisted' as const, requestId };
    },
  };
}
