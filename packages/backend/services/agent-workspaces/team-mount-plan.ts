import { planRegisteredWorkspaceMounts, type RegisteredProjectRoot, type WorkspaceMountLocator } from './mount-plan.js';

export interface TeamWorkspaceMountInventoryEntry {
  workspaceId: string;
  ownerProjectId: string;
}
export interface RegisteredTeamWorkspaceLocator extends TeamWorkspaceMountInventoryEntry {
  locator: WorkspaceMountLocator;
}
export interface TeamWorkspaceMountInput {
  agentProjectId: string;
  /** Current server-verified inventory for this user and running Agent's team. */
  inventory: TeamWorkspaceMountInventoryEntry[];
  /** Original registered storage locators, not paths inferred from inventory. */
  storageLocators: RegisteredTeamWorkspaceLocator[];
  /** Full original project registry, including projects outside this team. */
  projectRoots: RegisteredProjectRoot[];
}

/** Internal pure mount intent seam, not an endpoint, permission checker or executor.
 * The server must first verify the current user, active team membership, running
 * Agent/team association and active target workspaces (e.g. listCurrentTeamWorkspaces).
 * None of these arrays may be accepted as permission-bearing request JSON.
 * Keep original storage/project registries: deriving either from inventory would
 * erase ownership/source mismatch evidence. Team membership is NOT converted to
 * Project membership or WorkspaceAccessFacts/direct grants.
 * Ordinary team files default to rw; this grants no Session or Credential access.
 * Actual executor wiring, revocation and OS confinement remain unfinished.
 */
export function planTeamWorkspaceMounts(input: TeamWorkspaceMountInput) {
  if (!input.agentProjectId.trim()) throw new Error('AGENT_WORKSPACE_CONTEXT_REQUIRED');
  const locators = new Map<string, RegisteredTeamWorkspaceLocator>();
  for (const entry of input.storageLocators) {
    if (!entry.workspaceId.trim() || !entry.ownerProjectId.trim() || locators.has(entry.workspaceId)) {
      throw new Error('WORKSPACE_MOUNT_DUPLICATE_OR_INVALID');
    }
    locators.set(entry.workspaceId, entry);
  }
  return planRegisteredWorkspaceMounts({ agentProjectId: input.agentProjectId,
    projectRoots: input.projectRoots, candidates: input.inventory,
    resolve: candidate => {
      if (!candidate.ownerProjectId.trim()) throw new Error('WORKSPACE_MOUNT_DUPLICATE_OR_INVALID');
      const registered = locators.get(candidate.workspaceId);
      if (!registered) throw new Error('WORKSPACE_STORAGE_LOCATOR_UNAVAILABLE');
      if (registered.ownerProjectId !== candidate.ownerProjectId) throw new Error('WORKSPACE_MOUNT_REGISTRY_MISMATCH');
      return { ownerProjectId: candidate.ownerProjectId, locator: registered.locator,
        ownWorkspace: candidate.ownerProjectId === input.agentProjectId,
        finish: () => ({ readOnly: false }) };
    },
  });
}
