import { resolveAgentFileReference } from './file-reference.js';
import {
  resolveProjectWorkspaceFile,
} from '../project-environment/project-workspace-files.js';
import { assertExpectedStorage, projectWorkspaceStorageAdapter } from '../project-environment/adapters/project-workspace-storage-adapter.js';
import { MAX_CANONICAL_WORKSPACE_READ_BYTES } from '../project-environment/adapters/canonical-host-file-adapter.js';

const MAX_BYTES = MAX_CANONICAL_WORKSPACE_READ_BYTES;

/** Internal common read seam. No HTTP route is enabled until current Agent context is wired. */
export async function readAgentWorkspaceFile(input: Omit<Parameters<typeof resolveAgentFileReference>[0], 'operation'> & { maxBytes?: number }) {
  const maxBytes = input.maxBytes ?? MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw new Error('WORKSPACE_READ_LIMIT_INVALID');
  const target = await resolveAgentFileReference({ ...input, operation: 'read' });
  if (input.ref.relativePath === '.') throw new Error('WORKSPACE_READ_FILE_REQUIRED');
  const reference = await resolveProjectWorkspaceFile({
    projectId: target.ownerProjectId,
    projectRoot: target.projectRoot,
    relativePath: input.ref.relativePath,
  });
  // Current team or legacy access was checked by FileRef resolution. Neither
  // provenance is direct target-Project membership; both share this adapter.
  assertExpectedStorage(reference, target.storage);
  const adapter = projectWorkspaceStorageAdapter(reference);
  const bytes = await adapter.readBytes(reference, input.userId, maxBytes);
  return { ref: { ...input.ref }, storageKind: adapter.kind, bytes };
}
