/** @deprecated Project workspace authority is owned by services/project-environment. */
export {
  explicitProjectWorkspaceTarget as explicitFileStorageTarget,
  listProjectWorkspaceAuthorities as listProjectFileStorageBindings,
  provisionCanonicalProjectWorkspace as provisionCanonicalProjectFileStorage,
  resolveProjectWorkspaceTarget as resolveProjectFileStorageTarget,
} from '../project-environment/project-workspace-authority.js';
export type { ProjectWorkspaceAuthority as ProjectFileStorageBinding } from '../project-environment/project-workspace-authority.js';
