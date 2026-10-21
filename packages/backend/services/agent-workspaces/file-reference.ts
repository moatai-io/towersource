import path from 'node:path';
import { query } from '../../db/pg-repo.js';
import { requireAgentWorkspaceAccess, type WorkspaceOperation } from './access.js';
import { resolveProjectWorkspaceTarget } from '../project-environment/project-workspace-authority.js';
import { resolveProjectEnvironmentDeploymentId } from '../project-environment/project-environment-deployment.js';
import { listCurrentTeamWorkspaces } from './team-inventory.js';
import { resolveTeamAgentContext } from './team-context.js';

/** Provenance is not a reusable permission token. Team identity is re-resolved;
 * the context API currently exposes no version, so no fake grant is created.
 */
export type AgentFileAccess =
  | (Awaited<ReturnType<typeof requireAgentWorkspaceAccess>> & { provenance: 'legacy' })
  | { provenance: 'team'; teamId: string; ownerProjectId: string; workspaceKind: 'project' };

async function resolveFileAccess(input: {
  userId: number; agentProjectId: string; workspaceId: string; operation: WorkspaceOperation;
}): Promise<AgentFileAccess> {
  if (process.env.TOWER_TEAM_WORKSPACES_ENABLED === '1') {
    const context = await resolveTeamAgentContext(input);
    const workspaces = await listCurrentTeamWorkspaces({ userId: input.userId, agentProjectId: input.agentProjectId });
    if (workspaces !== null) {
      const workspace = workspaces.find(entry => entry.workspaceId === input.workspaceId);
      if (!workspace) throw new Error('TEAM_WORKSPACE_NOT_GRANTED');
      const current = await resolveTeamAgentContext(input);
      if (!context || !current || current.teamId !== context.teamId) throw new Error('TEAM_WORKSPACE_CONTEXT_CHANGED');
      return { provenance: 'team', teamId: current.teamId, ownerProjectId: workspace.ownerProjectId, workspaceKind: 'project' };
    }
    // Only a teamless null inventory admits the unchanged legacy policy.
    // A team appearing/disappearing across queries is not a fallback condition.
    if (context || await resolveTeamAgentContext(input)) throw new Error('TEAM_WORKSPACE_CONTEXT_CHANGED');
  }
  return { ...await requireAgentWorkspaceAccess(input), provenance: 'legacy' };
}

export interface AgentFileRef {
  agentProjectId: string;
  workspaceId: string;
  /** Decoded POSIX path, never an absolute host path or a URL. */
  relativePath: string;
}
export function validateAgentFileRef(ref: AgentFileRef) {
  if (!ref || typeof ref.agentProjectId !== 'string' || !ref.agentProjectId.trim()
    || typeof ref.workspaceId !== 'string' || !ref.workspaceId.trim()
    || ref.agentProjectId.length > 200 || ref.workspaceId.length > 200
    || typeof ref.relativePath !== 'string' || ref.relativePath.length > 4096) throw new Error('WORKSPACE_FILE_REF_INVALID');
  if (ref.relativePath === '.') return;
  // Reject escaped path syntax rather than decoding twice at different layers.
  if (!ref.relativePath || /[\\\x00-\x1f\x7f:%]/.test(ref.relativePath)
    || ref.relativePath.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('WORKSPACE_RELATIVE_PATH_INVALID');
}

/** Resolve metadata only; NOT a filesystem sandbox or a reusable access token.
 * The I/O adapter must enforce symlink/fd containment and recheck writes at commit.
 * trustedAgentProjectId must come from the server session, never the request body.
 */
export async function resolveAgentFileReference(input: {
  userId: number; trustedAgentProjectId: string; ref: AgentFileRef; operation: WorkspaceOperation;
}) {
  validateAgentFileRef(input.ref);
  if (input.ref.agentProjectId !== input.trustedAgentProjectId) throw new Error('AGENT_FILE_CONTEXT_MISMATCH');
  if (!['read', 'write'].includes(input.operation)) throw new Error('WORKSPACE_OPERATION_INVALID');
  if (input.operation === 'write' && input.ref.relativePath === '.') throw new Error('WORKSPACE_ROOT_MUTATION_DENIED');
  const access = await resolveFileAccess({ userId: input.userId, agentProjectId: input.trustedAgentProjectId, workspaceId: input.ref.workspaceId, operation: input.operation });
  // Inventory is logical ownership metadata, never a guessed host storage path.
  const projects = await query<{ id: string; root_path: string }>('SELECT id,root_path FROM projects ORDER BY length(root_path) DESC');
  const ownerRootPath = access.provenance === 'legacy' ? access.ownerRootPath
    : projects.find(project => project.id === access.ownerProjectId)?.root_path;
  // Shared skill roots need a separately registered resource locator.
  if (access.workspaceKind !== 'project' || !access.ownerProjectId || !ownerRootPath || !path.isAbsolute(ownerRootPath)) throw new Error('WORKSPACE_STORAGE_LOCATOR_UNAVAILABLE');
  const root = path.resolve(ownerRootPath);
  if (root === path.parse(root).root) throw new Error('WORKSPACE_STORAGE_LOCATOR_INVALID');
  const hostPath = path.resolve(root, input.ref.relativePath);
  // A nested registered Project is not implicitly shared by sharing its parent.
  const owner = projects.find(p => p.root_path && (hostPath === path.resolve(p.root_path) || hostPath.startsWith(path.resolve(p.root_path) + path.sep)));
  if (!owner || owner.id !== access.ownerProjectId) throw new Error('WORKSPACE_NESTED_PROJECT_NOT_GRANTED');
  const deploymentId = resolveProjectEnvironmentDeploymentId();
  const storage = await resolveProjectWorkspaceTarget(access.ownerProjectId, deploymentId);
  if (storage?.workstationMode && !storage.defaultWorkerId) throw new Error('WORKSPACE_STORAGE_CONFIGURATION_CONFLICT');
  return { ref: { ...input.ref }, access, deploymentId, ownerProjectId: access.ownerProjectId,
    projectRoot: root, hostPath,
    storage: storage?.workstationMode
      ? { kind: 'worker' as const, workerId: storage.defaultWorkerId! }
      : { kind: 'host' as const, workerId: null } };
}
