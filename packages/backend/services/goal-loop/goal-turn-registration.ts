import type { PoolClient } from 'pg';
/** Called only after request persistence and shared admission authorization in
 * the same transaction. Requires the execution-request FK transition. No engine
 * dispatch; running means registered under the existing turn lifecycle contract.
 */
export async function registerInternalGoalTurn(client: PoolClient, requestId: string): Promise<void> {
  const request = await client.query<{session_id:string;goal_id:string;source_user_message_id:string}>(
    'SELECT session_id,goal_id,source_user_message_id FROM goal_internal_requests WHERE id=$1 FOR UPDATE', [requestId]);
  const row = request.rows[0];
  if (!row) throw new Error('INTERNAL_REQUEST_NOT_FOUND');
  const source = await client.query("SELECT id FROM messages WHERE id=$1 AND session_id=$2 AND role='user'", [row.source_user_message_id,row.session_id]);
  if (!source.rowCount) throw new Error('INTERNAL_REQUEST_SOURCE_INVALID');
  await client.query(`INSERT INTO execution_requests_draft
    (id,session_id,source_user_message_id,origin,dedupe_key,goal_id)
    VALUES($1,$2,$3,'goal',$4,$5)`,[requestId,row.session_id,row.source_user_message_id,`goal-request:${requestId}`,row.goal_id]);
  await client.query(`INSERT INTO agent_turns(root_turn_id,session_id,state,accepted_at,execution_started_at)
    VALUES($1,$2,'running',now(),now())`,[requestId,row.session_id]);
}
