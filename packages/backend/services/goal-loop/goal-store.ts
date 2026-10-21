import { transaction } from '../../db/pg-repo.js';
import type { GoalCommand, GoalScope, GoalRecord, GoalStore } from './goal-session.js';

import type { PoolClient } from 'pg';

export interface TransactionalGoalGuard {
  /** Must lock/check current root, owner fence, approval and stop state using this client.
   * Check commands must also validate immutable evidence under the same transaction.
   * Do not do network/model calls while holding locks. Return false on uncertainty.
   */
  validate(client: PoolClient, scope: GoalScope, previous: GoalRecord | null, command: GoalCommand): Promise<boolean>;
}

/** Inactive until the draft schema is approved/applied and tool registration is wired. */
export function createPostgresGoalStore(guard: TransactionalGoalGuard): GoalStore { return {
  async transact(scope, fn, command) {
    return transaction(async client => {
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      // Lock the parent session so concurrent first inserts are serialized too.
      // Deliberately owner-only, not a project-visibility permission shortcut.
      const authorized = await client.query(
        `SELECT s.id FROM sessions s
         JOIN projects p ON p.id = s.project_id
         JOIN messages m ON m.id = $4 AND m.session_id = s.id AND m.role = 'user'
         WHERE s.id = $1 AND s.user_id = $2 AND s.project_id = $3
           AND COALESCE(s.archived, 0) = 0 AND COALESCE(p.archived, 0) = 0
           AND (p.user_id = $2 OR EXISTS (
             SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $2))
         FOR UPDATE OF s`,
        [scope.sessionId, scope.userId, scope.projectId, scope.rootTurnId],
      );
      if (!authorized.rowCount) throw new Error('GOAL_ACCESS_DENIED');
      const loaded = await client.query<{ record: GoalRecord }>(
        'SELECT record FROM goal_sessions WHERE root_turn_id = $1 FOR UPDATE', [scope.rootTurnId],
      );
      const next = fn(loaded.rows[0]?.record ?? null);
      // Status calls return the identical record and must not mutate timestamps.
      if (next.record === (loaded.rows[0]?.record ?? null)) return next.result;
      if (!next.record) throw new Error('GOAL_RECORD_REQUIRED');
      if (!command || !await guard.validate(client, scope, structuredClone(loaded.rows[0]?.record ?? null), command)) {
        throw new Error('GOAL_TRANSACTION_GUARD_DENIED');
      }
      await client.query(
        `INSERT INTO goal_sessions (root_turn_id, session_id, user_id, project_id, record)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (root_turn_id) DO UPDATE SET record = EXCLUDED.record, updated_at = NOW()`,
        [scope.rootTurnId, scope.sessionId, scope.userId, scope.projectId, JSON.stringify(next.record)],
      );
      return next.result;
    });
  },
}; }

/** Fail closed until the host provides real transactional checks. */
export const postgresGoalStore = createPostgresGoalStore({ validate: async () => false });
