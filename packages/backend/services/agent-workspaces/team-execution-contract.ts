import type { RemoteWorkbenchJobSpec } from '../execution/remote-job-runner.js';
import type { RemoteWorkbenchWorkerServerOptions } from '../execution/worker/worker-server.js';
import type { resolveTeamWorkspaceMountContext } from './team-mount-context.js';

// Exact existing Remote spec keys, not a new wire protocol or capability flag.
const SPEC_KEYS = new Set<keyof RemoteWorkbenchJobSpec>([
  'lifecycle', 'jobId', 'projectId', 'actorUserId', 'sessionId', 'workspaceId',
  'command', 'cwd', 'timeoutSec', 'workbenchRevision', 'environmentKeys', 'artifacts',
]);

/** Internal pre-dispatch guard, NOT activated in provider/transport/Worker yet.
 * Use the unmodified spec BEFORE parsing/serializing can drop unknown fields and
 * BEFORE signing or consuming credentials. The team context must be freshly
 * server-resolved; neither it nor this guard is an execution authorization token.
 * Execution grants now bind team/mount contents and Worker admission rejects
 * unsupported or unsigned team scope. Installed-executor mount enforcement is
 * still unavailable. No
 * current capability proves exact team mount enforcement, so EVERY team request
 * is rejected, including project-sandbox-v1. Do not substitute shell/job/native
 * availability or a client-provided flag for that missing capability.
 * This checks compatibility only: existing spec validation/receipts, planner
 * source checks and OS source pinning remain separately mandatory.
 * Future support requires an approved authenticated protocol plus real executor
 * enforcement; adding a boolean here must never enable unsupported execution.
 */
export function assertTeamExecutionContract(input: {
  spec: RemoteWorkbenchJobSpec;
  teamMountContext: Awaited<ReturnType<typeof resolveTeamWorkspaceMountContext>>;
  executionBackend?: RemoteWorkbenchWorkerServerOptions['executionBackend'];
  isolationProfile?: RemoteWorkbenchWorkerServerOptions['isolationProfile'];
}): void {
  if (Object.keys(input.spec).some(key => !SPEC_KEYS.has(key as keyof RemoteWorkbenchJobSpec))) {
    throw new Error('TEAM_EXECUTION_SPEC_UNSUPPORTED');
  }
  if (input.teamMountContext === null) return;
  if (input.teamMountContext.agentProjectId !== input.spec.projectId) throw new Error('TEAM_EXECUTION_CONTEXT_MISMATCH');
  if (input.spec.lifecycle !== undefined || input.spec.workspaceId !== undefined) throw new Error('TEAM_EXECUTION_SPEC_UNSUPPORTED');
  if (input.executionBackend === 'installed-executor') throw new Error('TEAM_EXECUTION_NATIVE_UNSUPPORTED');
  if (input.isolationProfile !== 'project-sandbox-v1') throw new Error('TEAM_EXECUTION_SANDBOX_REQUIRED');
  throw new Error('TEAM_EXECUTION_CAPABILITY_UNSUPPORTED');
}
