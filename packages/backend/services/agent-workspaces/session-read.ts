/** Internal only. Auth middleware supplies userId, never request JSON.
 * Session visibility does not grant workspace access: common I/O still checks it.
 */
import { queryOne } from '../../db/pg-repo.js';
import { canAccessSession } from '../pm/project-access.js';
import { readAgentWorkspaceRequest } from './read-request.js';

export async function readSessionAgentWorkspaceFile(input: { userId: number; sessionId: string; body: unknown }) {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0 || typeof input.sessionId !== 'string'
    || !input.sessionId.trim() || input.sessionId.length > 200) throw new Error('AGENT_FILE_CONTEXT_REQUIRED');
  const user = await queryOne<{ role: string; disabled: number }>('SELECT role, disabled FROM users WHERE id=$1', [input.userId]);
  if (!user || user.disabled !== 0) throw new Error('AGENT_FILE_USER_INACTIVE');
  const session = await queryOne<{ project_id: string | null }>('SELECT project_id FROM sessions WHERE id=$1', [input.sessionId]);
  const access = await canAccessSession(input.sessionId, input.userId, user.role);
  if (!access.allowed) throw new Error('AGENT_FILE_SESSION_ACCESS_DENIED');
  if (!session?.project_id) throw new Error('AGENT_FILE_SESSION_PROJECT_REQUIRED');
  // Detect relocation between context lookup and visibility authorization.
  const current = await queryOne<{ project_id: string | null }>('SELECT project_id FROM sessions WHERE id=$1', [input.sessionId]);
  if (current?.project_id !== session.project_id) throw new Error('AGENT_FILE_SESSION_CHANGED');
  return readAgentWorkspaceRequest({ userId: input.userId, agentProjectId: session.project_id }, input.body);
}
