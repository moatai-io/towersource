import { query } from '../../db/pg-repo.js';
import {
  explicitProjectWorkspaceTarget,
  listProjectWorkspaceAuthorities,
} from '../project-environment/project-workspace-authority.js';
import { readLegacyProjectComputePlacement } from '../project-environment/adapters/legacy-project-compute-adapter.js';
import { loadTeamWorkspacePolicyInput, requireCurrentTeamFacts } from './team-repository.js';
import { listTeamWorkspaceIds } from './team-workspace-policy.js';
import { planTeamWorkspaceMounts, type TeamWorkspaceMountInventoryEntry } from './team-mount-plan.js';

interface TeamMountServerContext { userId: number; agentProjectId: string; deploymentId: string }

async function loadInventory(input: TeamMountServerContext) {
  const facts = await loadTeamWorkspacePolicyInput(input);
  requireCurrentTeamFacts(facts);
  if (facts.agent.teamId === null) return { teamId: null, inventory: [] };
  const allowedIds = new Set(listTeamWorkspaceIds(facts));
  const inventory = facts.workspaces.filter(workspace => allowedIds.has(workspace.workspaceId))
    .map(({ workspaceId, ownerProjectId }) => ({ workspaceId, ownerProjectId }));
  return { teamId: facts.agent.teamId, inventory };
}

async function loadStorage(input: TeamMountServerContext, inventory: TeamWorkspaceMountInventoryEntry[]) {
  // Full original registry, including archived/outside-team projects, is required:
  // a parent bind must not expose their registered nested roots. No user-filtered
  // getProjects() call and no root derived from the team inventory may replace it.
  const [projects, authorities] = await Promise.all([
    query<{ id: string; root_path: string | null }>('SELECT id, root_path FROM projects'),
    listProjectWorkspaceAuthorities(input.deploymentId),
  ]);
  // A Project with no registered root has no host storage to nest or mount.
  // Preserve every non-null root, even outside the admitted team.
  const projectRoots = projects.filter((row): row is { id: string; root_path: string } => row.root_path !== null)
    .map(row => ({ projectId: row.id, root: row.root_path }));
  const storageLocators = [];
  const versions = [];
  // Batch canonical authority once per snapshot. These are the same canonical
  // authority classifier and legacy adapter used by resolveProjectWorkspaceTarget;
  // per-project calls to that resolver would repeatedly query the entire table.
  for (const workspace of inventory) {
    const registeredRoots = projectRoots.filter(project => project.projectId === workspace.ownerProjectId);
    if (registeredRoots.length !== 1) throw new Error('WORKSPACE_MOUNT_SOURCE_UNREGISTERED');
    const bindings = authorities.filter(row => row.project_id === workspace.ownerProjectId && row.deployment_id === input.deploymentId);
    if (bindings.length > 1) throw new Error('WORKSPACE_STORAGE_CONFIGURATION_CONFLICT');
    const authority = bindings[0];
    const storage = authority ? explicitProjectWorkspaceTarget(authority)
      : await readLegacyProjectComputePlacement(workspace.ownerProjectId, input.deploymentId);
    if (storage?.workstationMode) {
      if (!storage.defaultWorkerId?.trim()) throw new Error('WORKSPACE_STORAGE_CONFIGURATION_CONFLICT');
      throw new Error('WORKSPACE_REMOTE_MOUNT_UNSUPPORTED');
    }
    storageLocators.push({ ...workspace, locator: { kind: 'host' as const, root: registeredRoots[0].root } });
    versions.push({ workspaceId: workspace.workspaceId, authority: authority ?? null });
  }
  return { projectRoots, storageLocators, versions };
}

function inventoryKey(inventory: TeamWorkspaceMountInventoryEntry[]) {
  return JSON.stringify([...inventory].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)));
}

/** Internal server seam: identifiers must come from the authenticated server
 * context, never a body-supplied user/Agent/deployment or permission-bearing array.
 * Reads current team inventory and original registered storage authority; does not
 * create Project membership, direct grants, mounts or Worker execution authority.
 * null means confirmed active teamless facts ONLY. Rollout/off/legacy admission
 * stays with the caller; denied team state and repository errors must propagate.
 * Rechecks detect observed membership/team/inventory/storage changes during
 * resolution, but snapshots are not atomic with later execution. This result is
 * NOT a bearer token: consumers must re-resolve current authority before use.
 * OS/symlink confinement, process revocation and actual executor wiring remain
 * unfinished. No environment or executor activation occurs here.
 */
export async function resolveTeamWorkspaceMountContext(input: TeamMountServerContext) {
  if (typeof input.deploymentId !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(input.deploymentId)) {
    throw new Error('TEAM_WORKSPACE_MOUNT_CONTEXT_REQUIRED');
  }
  const initial = await loadInventory(input);
  if (initial.teamId === null) {
    if ((await loadInventory(input)).teamId !== null) throw new Error('TEAM_WORKSPACE_CONTEXT_CHANGED');
    return null;
  }
  if (!initial.inventory.some(workspace => workspace.ownerProjectId === input.agentProjectId)) {
    throw new Error('TEAM_WORKSPACE_OWN_WORKSPACE_REQUIRED');
  }
  const first = await loadStorage(input, initial.inventory);
  const mounts = planTeamWorkspaceMounts({ agentProjectId: input.agentProjectId, inventory: initial.inventory, ...first });
  const current = await loadStorage(input, initial.inventory);
  const currentMounts = planTeamWorkspaceMounts({ agentProjectId: input.agentProjectId, inventory: initial.inventory, ...current });
  const final = await loadInventory(input);
  if (initial.teamId !== final.teamId || inventoryKey(initial.inventory) !== inventoryKey(final.inventory)) {
    throw new Error('TEAM_WORKSPACE_CONTEXT_CHANGED');
  }
  if (JSON.stringify(mounts) !== JSON.stringify(currentMounts) || JSON.stringify(first.versions) !== JSON.stringify(current.versions)) {
    throw new Error('WORKSPACE_STORAGE_CHANGED');
  }
  return { agentProjectId: input.agentProjectId, deploymentId: input.deploymentId, teamId: initial.teamId, mounts };
}
