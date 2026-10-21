/** Pure fail-closed mount intent planners, not executors or OS isolation proof.
 * Source locators come from registered storage inventory, never request JSON.
 * Remote storage is not silently treated as a host mirror.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { evaluateAgentWorkspaceAccess, type WorkspaceAccessFacts } from './access.js';

export type WorkspaceMountLocator = { kind: 'host'; root: string } | { kind: 'worker'; workerId: string };
export interface WorkspaceMountCandidate {
  workspaceId: string;
  facts: WorkspaceAccessFacts;
  locator: WorkspaceMountLocator;
}
export interface RegisteredProjectRoot { projectId: string; root: string }

/** Internal geometry-only planner shared by grant and team policy adapters.
 * This function does NOT authorize membership or access. Callers must supply
 * current server-verified authority and registered locators, never request JSON.
 * resolve runs per candidate before source validation; finish runs afterwards,
 * preserving the legacy grant planner's fail-closed evaluation order.
 * Full projectRoots inventory (including non-team projects) is required to
 * detect nested projects. Lexical checks do not prove OS/symlink confinement.
 */
export function planRegisteredWorkspaceMounts<Candidate extends { workspaceId: string }, Metadata extends { readOnly: boolean }>(input: {
  agentProjectId: string;
  projectRoots: RegisteredProjectRoot[];
  candidates: Candidate[];
  resolve: (candidate: Candidate) => {
    ownerProjectId: string | null;
    locator: WorkspaceMountLocator;
    /** Grant facts may additionally pin a root, independently of the registry. */
    expectedSource?: string | null;
    ownWorkspace: boolean;
    finish: () => Metadata;
  };
}) {
  if (!input.agentProjectId.trim()) throw new Error('AGENT_WORKSPACE_CONTEXT_REQUIRED');
  const seen = new Set<string>();
  const sources: string[] = [];
  return input.candidates.map(candidate => {
    if (!candidate.workspaceId.trim() || seen.has(candidate.workspaceId)) throw new Error('WORKSPACE_MOUNT_DUPLICATE_OR_INVALID');
    seen.add(candidate.workspaceId);
    const resolved = input.resolve(candidate);
    if (resolved.locator.kind !== 'host') throw new Error('WORKSPACE_REMOTE_MOUNT_UNSUPPORTED');
    const source = resolved.locator.root;
    if (!path.isAbsolute(source) || path.resolve(source) !== source || source === '/' || /[\x00-\x1f\x7f]/.test(source)
      || ('expectedSource' in resolved && resolved.expectedSource !== source)) throw new Error('WORKSPACE_MOUNT_SOURCE_INVALID');
    if (!input.projectRoots.some(p => p.projectId === resolved.ownerProjectId && p.root === source)) throw new Error('WORKSPACE_MOUNT_SOURCE_UNREGISTERED');
    if (input.projectRoots.some(p => p.projectId !== resolved.ownerProjectId && path.resolve(p.root).startsWith(source + path.sep))) throw new Error('WORKSPACE_MOUNT_NESTED_PROJECT');
    if (sources.some(p => p === source || p.startsWith(source + path.sep) || source.startsWith(p + path.sep))) throw new Error('WORKSPACE_MOUNT_OVERLAP');
    sources.push(source);
    const metadata = resolved.finish();
    const key = createHash('sha256').update(candidate.workspaceId).digest('hex');
    return { workspaceId: candidate.workspaceId, source,
      target: resolved.ownWorkspace ? '/workspace' : `/connected/${key}`, ...metadata };
  });
}

export function planAgentWorkspaceMounts(input: {
  agentProjectId: string;
  /** Existing registered project roots. Nested projects cannot leak via parent mounts. */
  projectRoots: RegisteredProjectRoot[];
  candidates: WorkspaceMountCandidate[];
}) {
  return planRegisteredWorkspaceMounts({ ...input, resolve: candidate => {
    const access = evaluateAgentWorkspaceAccess(input.agentProjectId, 'read', candidate.facts);
    // A global/shared-skill resource needs its own registered locator contract.
    if (candidate.facts.workspace_kind !== 'project') throw new Error('WORKSPACE_STORAGE_LOCATOR_UNAVAILABLE');
    return { ownerProjectId: candidate.facts.owner_project_id, locator: candidate.locator,
      expectedSource: candidate.facts.owner_root_path, ownWorkspace: access.ownWorkspace,
      finish: () => {
        let readOnly = true;
        if (access.mode === 'read-write') {
          try { evaluateAgentWorkspaceAccess(input.agentProjectId, 'write', candidate.facts); readOnly = false; }
          catch (error) { if (!(error instanceof Error) || error.message !== 'AGENT_WRITE_DENIED') throw error; }
        }
        return { readOnly, grantVersion: access.grantVersion };
      } };
  } });
}
