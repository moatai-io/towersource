import type { PoolClient } from 'pg';

/** Draft-schema recovery gate. Discovery only, never claim authorization.
 * A dispatcher must recheck in the claim transaction. Not registered by default.
 */
export async function inspectExecutionRecovery(client: PoolClient, requestId: string, sessionId: string): Promise<'eligible' | 'denied' | 'busy'> {
  const loaded = await client.query(`SELECT r.origin,r.goal_id,r.source_user_message_id,
    t.state,t.owner_token,t.waiting_user_started_at,
    (t.next_attempt_at IS NULL OR t.next_attempt_at<=NOW()) AS due,
    s.user_id,s.project_id,
    COALESCE(t.accepted_at,t.created_at) >= NOW()-interval '24 hours' AS recent,
    m.created_at AS source_at
    FROM execution_requests_draft r
    JOIN sessions s ON s.id=r.session_id AND COALESCE(s.archived,0)=0
    JOIN projects p ON p.id=s.project_id AND COALESCE(p.archived,0)=0
    JOIN messages m ON m.id=r.source_user_message_id AND m.session_id=r.session_id AND m.role='user'
    JOIN agent_turns t ON t.root_turn_id=r.id AND t.session_id=r.session_id
    WHERE r.id=$1 AND r.session_id=$2
      AND (p.user_id=s.user_id OR EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.user_id=s.user_id))`,[requestId,sessionId]);
  const row=loaded.rows[0];
  if(!row || !row.recent || row.waiting_user_started_at || row.state!=='waiting_retry') return 'denied';
  if(row.owner_token || !row.due) return 'busy';
  const newer=await client.query(`SELECT id FROM messages WHERE session_id=$1 AND role='user'
    AND id<>$2 AND created_at >= $3 LIMIT 1`,[sessionId,row.source_user_message_id,row.source_at]);
  if(newer.rowCount) return 'denied';
  if(row.origin==='goal') {
    const goals=await client.query(`SELECT id FROM managed_goals WHERE id=$1
      AND record->>'sessionId'=$2 AND record->'state'->>'status'='running'
      AND record->>'userId'=$4 AND record->>'projectId'=$5
      AND record->'activeExecution'->>'rootTurnId'=$3`,[row.goal_id,sessionId,requestId,String(row.user_id),row.project_id]);
    if(!goals.rowCount) return 'denied';
  }
  const effects=await client.query(`SELECT id FROM side_effect_executions WHERE session_id=$1
    AND status IN ('running','uncertain') LIMIT 1`,[sessionId]);
  return effects.rowCount ? 'denied' : 'eligible';
}
