import { queryOne } from '../../db/pg-repo.js';

/** Conversation privacy does not make Agent files private. Shared writes remain
 * subject to the ordinary file authority and explicit publication approvals. */
export async function assertSessionAllowsSharedArtifactWrite(sessionId?: string): Promise<void> {
  if (!sessionId) return;
  const session = await queryOne('SELECT visibility FROM sessions WHERE id = $1', [sessionId]);
  if (!session) throw new Error('Session not found: shared artifact write requires an existing conversation');
}
