import { resolveAgentFileReference, type AgentFileAccess } from './file-reference.js';
import {
  resolveProjectWorkspaceFile,
} from '../project-environment/project-workspace-files.js';
import { assertExpectedStorage, projectWorkspaceStorageAdapter } from '../project-environment/adapters/project-workspace-storage-adapter.js';
import { MAX_CANONICAL_WORKSPACE_TEXT_BYTES } from '../project-environment/adapters/canonical-host-file-adapter.js';

const LIMIT = MAX_CANONICAL_WORKSPACE_TEXT_BYTES;

// Identity stability is not version/ABA protection: current context exposes no
// membership/team revision. Revoke/regrant between checks remains unobservable.
function sameAccessSnapshot(target: AgentFileAccess, current: AgentFileAccess) {
  if (target.provenance !== current.provenance) return false;
  if (target.provenance === 'team' && current.provenance === 'team') return target.teamId === current.teamId;
  return target.provenance !== 'team' && current.provenance !== 'team' && target.grantVersion === current.grantVersion;
}

/** Existing UTF-8 files only. Atomic publication, NOT a filesystem-wide CAS:
 * arbitrary bash writers do not participate in a common lock. Route activation
 * must await write coordination/mount enforcement.
 */
export async function replaceAgentWorkspaceText(input: Omit<Parameters<typeof resolveAgentFileReference>[0], 'operation'> & { expectedContent: string; content: string }) {
  if (typeof input.content !== 'string' || typeof input.expectedContent !== 'string'
    || Buffer.byteLength(input.content) > LIMIT || Buffer.byteLength(input.expectedContent) > LIMIT) throw new Error('WORKSPACE_WRITE_LIMIT_INVALID');
  const target = await resolveAgentFileReference({ ...input, operation: 'write' });
  const current = await resolveAgentFileReference({ ...input, operation: 'write' });
  if (current.projectRoot !== target.projectRoot || current.ownerProjectId !== target.ownerProjectId
    || current.deploymentId !== target.deploymentId || current.storage.kind !== target.storage.kind
    || current.storage.workerId !== target.storage.workerId || !sameAccessSnapshot(target.access, current.access)) throw new Error('WORKSPACE_WRITE_CONTEXT_CHANGED');
  if (current.storage.kind === 'worker'
    && Buffer.byteLength(input.content) + Buffer.byteLength(input.expectedContent) > 32 * 1024) throw new Error('WORKSPACE_WORKER_WRITE_LIMIT');
  const reference = await resolveProjectWorkspaceFile({
    projectId: current.ownerProjectId,
    projectRoot: current.projectRoot,
    relativePath: input.ref.relativePath,
  });
  assertExpectedStorage(reference, current.storage);
  const adapter = projectWorkspaceStorageAdapter(reference);
  await adapter.compareAndSwapText(reference, input.userId, input.expectedContent, input.content);
  return { ref: { ...input.ref }, storageKind: adapter.kind, bytesWritten: Buffer.byteLength(input.content) };
}
