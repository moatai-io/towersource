/** Read-only creation preflight. Does not dispatch AI or authenticate with providers. */
import fs from 'node:fs/promises';
import { requireCurrentAgentExecutionAccess } from '../authority/agent-execution-access.js';

export async function inspectAutomationCreationReadiness(input: { projectId: string; userId: number; rootPath: string }) {
  // Resolve current DB authority, not the role snapshot supplied by a client/session.
  await requireCurrentAgentExecutionAccess({ projectId: input.projectId, userId: input.userId });
  const root = await fs.stat(input.rootPath);
  if (!root.isDirectory()) throw new Error('WORKSPACE_ROOT_NOT_DIRECTORY');
  await fs.access(input.rootPath, fs.constants.R_OK | fs.constants.X_OK);
  return { agentExecutionAccess: 'allowed' as const, workspacePath: 'accessible' as const };
}
