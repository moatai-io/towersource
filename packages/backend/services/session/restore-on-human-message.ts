import { execute } from '../../db/pg-repo.js';

/** Called only after message-send authorization, for an explicit human chat. */
export async function restoreOnHumanMessage(sessionId: string, userId: number): Promise<boolean> {
  const result = await execute(
    `UPDATE sessions SET archived = 0, archived_at = NULL
     WHERE id = $1 AND user_id = $2 AND archived = 1
       AND NOT EXISTS (SELECT 1 FROM agent_workers WHERE backing_session_id = sessions.id)`,
    [sessionId, userId],
  );
  return result.changes > 0;
}
