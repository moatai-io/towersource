/** Internal request boundary; deliberately not mounted on an HTTP router.
 * Context must be obtained from authenticated, server-resolved Session access.
 * A body-supplied Agent id is never a source of authority.
 */
import { validateAgentFileRef, type AgentFileRef } from './file-reference.js';
import { readAgentWorkspaceFile } from './read-file.js';

export async function readAgentWorkspaceRequest(
  context: { userId: number; agentProjectId: string },
  body: unknown,
) {
  if (!context || !Number.isSafeInteger(context.userId) || context.userId <= 0
    || typeof context.agentProjectId !== 'string' || !context.agentProjectId.trim()) throw new Error('AGENT_FILE_CONTEXT_REQUIRED');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('WORKSPACE_READ_REQUEST_INVALID');
  const payload = body as Record<string, unknown>;
  if (Object.keys(payload).some(key => !['ref', 'maxBytes'].includes(key))) throw new Error('WORKSPACE_READ_REQUEST_INVALID');
  const candidate = payload.ref;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
    || Object.keys(candidate).some(key => !['agentProjectId', 'workspaceId', 'relativePath'].includes(key))) throw new Error('WORKSPACE_FILE_REF_INVALID');
  const ref = candidate as AgentFileRef;
  validateAgentFileRef(ref);
  if (ref.agentProjectId !== context.agentProjectId) throw new Error('AGENT_FILE_CONTEXT_MISMATCH');
  if (payload.maxBytes !== undefined && (typeof payload.maxBytes !== 'number'
    || !Number.isSafeInteger(payload.maxBytes) || payload.maxBytes < 1 || payload.maxBytes > 8 * 1024 * 1024)) throw new Error('WORKSPACE_READ_LIMIT_INVALID');
  return readAgentWorkspaceFile({ userId: context.userId, trustedAgentProjectId: context.agentProjectId,
    ref: { agentProjectId: ref.agentProjectId, workspaceId: ref.workspaceId, relativePath: ref.relativePath },
    maxBytes: payload.maxBytes as number | undefined });
}
