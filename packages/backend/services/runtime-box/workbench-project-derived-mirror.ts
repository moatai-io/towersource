/**
 * Owns: compatibility boundary for disabled automatic host mirror replay.
 * Public API: mirrorWorkerProjectMutation.
 *
 * Worker storage remains authoritative. Host-shaped paths are not proof of a separate derived store.
 */
import type { WorkerFileAuthority } from './workbench-project-file-authority.js';

export type WorkerProjectMirrorMutation =
  | { kind: 'write-text'; hostPath: string; content: string }
  | { kind: 'upload'; hostPath: string; sourcePath: string }
  | { kind: 'mkdir'; hostPath: string }
  | { kind: 'delete'; hostPath: string }
  | { kind: 'rename'; oldHostPath: string; newHostPath: string }
  | { kind: 'copy'; sourceHostPath: string; targetHostPath: string };

/**
 * Automatic controller mirroring is disabled until storage topology proves the
 * destination is a separate derived store. A host-shaped path may alias the
 * authoritative Worker inode; replaying upload/delete/rename can corrupt it.
 * Worker mutation success remains authoritative. Legacy controller-only indexes
 * may be stale for remote storage and must be rebuilt through Worker reads.
 */
export function mirrorWorkerProjectMutation(
  _authority: WorkerFileAuthority,
  _mutation: WorkerProjectMirrorMutation,
): void {
  // Deliberately no filesystem operation, including for loopback Workers.
}
