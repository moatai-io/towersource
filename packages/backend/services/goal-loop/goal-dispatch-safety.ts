import type { PoolClient } from 'pg';
import type { ManagedGoal } from './goal-manager.js';

/** Persist this user-input anchor at initial authorized goal admission. Never
 * substitute the latest message at dispatch time: that would hide supersession.
 */
export interface GoalDispatchAuthority {
  goalId: string;
  userId: number;
  projectId: string;
  sessionId: string;
  userMessageId: string;
}
/** Actual SQL safety slice, not a complete dispatch authorization. Goal-specific
 * stop/revoke state and shared admission fencing are still required by gateway.
 */
export function createGoalDispatchSafety(authority: GoalDispatchAuthority, currentTool?: {
  /** Trusted per-call wrapper identity, never model input. */
  executionId: string; rootTurnId: string; ownerToken: string;
}) {
  const bound = Object.freeze({ ...authority });
  const own = currentTool ? Object.freeze({...currentTool}) : undefined;
  return async (client: PoolClient, goal: Readonly<ManagedGoal>): Promise<'ready' | 'busy' | 'denied'> => {
    if (goal.id !== bound.goalId || goal.userId !== bound.userId || goal.projectId !== bound.projectId
      || goal.sessionId !== bound.sessionId || !bound.userMessageId) return 'denied';
    const access = await client.query(`SELECT s.id FROM sessions s JOIN projects p ON p.id=s.project_id
      WHERE s.id=$1 AND s.user_id=$2 AND s.project_id=$3
      AND COALESCE(s.archived,0)=0 AND COALESCE(p.archived,0)=0
      AND (p.user_id=$2 OR EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.user_id=$2))
      FOR UPDATE OF s`, [bound.sessionId, bound.userId, bound.projectId]);
    if (!access.rowCount) return 'denied';
    const anchor = await client.query(`SELECT id FROM messages WHERE id=$1 AND session_id=$2 AND role='user'`,
      [bound.userMessageId, bound.sessionId]);
    if (!anchor.rowCount) return 'denied';
    // Equal timestamps are ambiguous, so block rather than arbitrarily order UUIDs.
    const newer = await client.query(`SELECT id FROM messages WHERE session_id=$1 AND role='user'
      AND id<>$2 AND created_at >= (SELECT created_at FROM messages WHERE id=$2) LIMIT 1`,
      [bound.sessionId, bound.userMessageId]);
    if (newer.rowCount) return 'denied';
    const effects = await client.query(`SELECT id FROM side_effect_executions
      WHERE session_id=$1 AND status IN ('running','uncertain')
      AND NOT COALESCE((status='running' AND id=COALESCE($2,'') AND root_turn_id=COALESCE($3,'')
        AND owner_token=COALESCE($4,'') AND tool_name='goal_step' AND lease_until>NOW()),false)
      LIMIT 1`, [bound.sessionId,own?.executionId ?? null,own?.rootTurnId ?? null,own?.ownerToken ?? null]);
    if (effects.rowCount) return 'denied';
    const turns = await client.query(`SELECT state, waiting_user_started_at FROM agent_turns
      WHERE session_id=$1 AND (state IN ('running','waiting_retry','stop_requested','needs_attention')
      OR waiting_user_started_at IS NOT NULL)`, [bound.sessionId]);
    if (turns.rows.some(r => r.waiting_user_started_at || ['stop_requested','needs_attention'].includes(r.state))) return 'denied';
    if (turns.rowCount) return 'busy';
    return 'ready';
  };
}
