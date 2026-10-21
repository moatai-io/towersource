/**
 * Owns: Fail-closed selection between Local Runtime and scheduler-selected Remote Workers.
 * Public API: selectWorkbenchExecutionProvider, resolveRemoteWorkbenchBinding.
 *
 * The legacy single-Worker env is now a registry bootstrap input. Foreground remains
 * local; durable Jobs and managed Services may run on a selected Remote Worker.
 */

import type {
  WorkbenchExecutionProvider,
  WorkbenchExecutionRequest,
} from '../execution/execution-broker.js';
import { planWorkbenchExecution } from '../execution/execution-broker.js';
import { createLocalWorkbenchExecutionProvider } from './workbench-local-execution-provider.js';
import { createRemoteWorkbenchExecutionProvider } from './workbench-remote-execution-provider.js';
import { createRemoteWorkbenchHttpTransport } from '../execution/worker/worker-http-transport.js';
import { createRemoteWorkbenchRsyncBridge } from './workbench-remote-rsync-bridge.js';
import {
  registerWorkbenchWorker,
  selectWorkbenchWorker,
  type WorkbenchWorkerView,
} from '../execution/worker/worker-registry.js';
import { releasePersistedWorkbenchWorkerSlot, reservePersistedWorkbenchWorkerSlot, selectPersistedWorkbenchWorker } from '../execution/worker/worker-repository.js';
import { resolveWorkbenchWorkerTransportToken } from '../execution/worker/worker-transport-credentials.js';
import { classifyWorkbenchWorkerCapacityWeight } from './workbench-worker-capacity-weight.js';
import type { ProjectComputeAuthorityMode } from './workbench-project-compute-settings.js';
import type { ResolvedProjectExecutionContext } from '../project-environment/project-execution-context.js';
import { resolveProjectEnvironmentDeploymentId } from '../project-environment/project-environment-deployment.js';
import { resolveTeamAgentContext } from '../agent-workspaces/team-context.js';

export interface RemoteWorkbenchBinding {
  workerId: string;
  baseUrl: string;
  token: string;
  projectIds: string[];
}

/** Resolve one operator-configured Worker binding; incomplete configuration fails closed to disabled. */
export function resolveRemoteWorkbenchBinding(env: NodeJS.ProcessEnv = process.env): RemoteWorkbenchBinding | null {
  const workerId = env.TOWER_REMOTE_WORKER_ID?.trim();
  const baseUrl = env.TOWER_REMOTE_WORKER_BASE_URL?.trim();
  const token = env.TOWER_REMOTE_WORKER_TOKEN?.trim();
  const projectIds = (env.TOWER_REMOTE_WORKER_PROJECT_IDS ?? '')
    .split(',').map(value => value.trim()).filter(Boolean);
  const configured = [workerId, baseUrl, token, projectIds.length ? 'projects' : ''].filter(Boolean).length;
  if (configured === 0) return null;
  if (!workerId || !baseUrl || !token || projectIds.length === 0) {
    throw new Error('REMOTE_WORKER_CONFIG_INCOMPLETE: worker id, base URL, token, and Project allowlist are all required');
  }
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('REMOTE_WORKER_CONFIG_INVALID: base URL must use http or https');
  return { workerId, baseUrl: url.toString().replace(/\/$/, ''), token, projectIds: [...new Set(projectIds)] };
}

function bootstrapLegacyRemoteWorker(binding: RemoteWorkbenchBinding, deploymentId: string, now?: number): void {
  registerWorkbenchWorker({
    workerId: binding.workerId,
    deploymentId,
    baseUrl: binding.baseUrl,
    capabilities: ['job', 'shell'],
    projectIds: binding.projectIds,
    capacity: { cpuTotal: 0, memoryMbTotal: 0, activeRuns: 0, maxRuns: 1 },
    now,
  });
}

export interface WorkbenchProviderSelectionInput {
  projectId: string;
  actorUserId?: number;
  sessionId?: string;
  projectRoot?: string;
  /**
   * Preferred long-lived Worker for this Project. This is a preference, not execution
   * authority: the selected Worker must still be healthy, Project-authorized, capable,
   * and transport-authenticated. Future Project settings should populate this field.
   */
  defaultWorkerId?: string;
  /** Opt this Project into Worker-local persistent workspace execution. */
  workstationMode?: boolean;
  /** Server-resolved Agent execution tier; retired operator-plane is never restored by requester role. */
  authorityMode?: ProjectComputeAuthorityMode;
  actorRole?: string;
  /** Current Tower execution plane. Workers from another deployment are never eligible. */
  deploymentId?: string;
  /** Whether an unbound Project may execute through the local Runtime Box compatibility provider. */
  runtimeBoxCompatibilityEnabled?: boolean;
  /** Current Backend-resolved Project Environment. Required to ignore legacy Worker Project scope. */
  executionContext?: ResolvedProjectExecutionContext;
  request: WorkbenchExecutionRequest;
  env?: NodeJS.ProcessEnv;
  localProvider?: WorkbenchExecutionProvider;
  selectWorker?: (input: { projectId: string; deploymentId?: string; requiredCapabilities: string[]; preferredWorkerId?: string }) => WorkbenchWorkerView;
  resolveWorkerToken?: (workerId: string) => string | null;
  now?: number;
}

/** Resolve the migration seam for a Project's long-lived default Worker preference. */
/** Stable execution-plane identity; explicit env wins and the dedicated dev port is a safe fallback. */
export { resolveProjectEnvironmentDeploymentId as resolveWorkbenchDeploymentId } from '../project-environment/project-environment-deployment.js';

export function resolveDefaultWorkbenchWorkerId(input: {
  defaultWorkerId?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  return input.defaultWorkerId?.trim()
    || input.env?.TOWER_WORKBENCH_DEFAULT_WORKER_ID?.trim()
    || undefined;
}

function listEnvSet(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map(item => item.trim()).filter(Boolean));
}

/**
 * Workstation-first projects use the Worker's persistent project root directly instead
 * of the migration rsync bridge. This is intentionally opt-in because rsync preserves the
 * older Runtime Box-like per-job workspace contract for other Projects.
 */
export function isWorkbenchWorkstationProject(input: { projectId: string; workstationMode?: boolean; env?: NodeJS.ProcessEnv }): boolean {
  if (input.workstationMode === true) return true;
  const projects = listEnvSet(input.env?.TOWER_WORKBENCH_WORKSTATION_PROJECT_IDS);
  return projects.has('*') || projects.has(input.projectId);
}

/** Workstation storage cannot silently move to another Worker's unrelated persistent root. */
export function assertWorkbenchDefaultWorkerSelected(input: {
  projectId: string;
  workstationMode?: boolean;
  env?: NodeJS.ProcessEnv;
  preferredWorkerId?: string;
  selectedWorkerId: string;
}): void {
  if (!isWorkbenchWorkstationProject(input) || !input.preferredWorkerId) return;
  if (input.selectedWorkerId !== input.preferredWorkerId) {
    throw new Error(`DEFAULT_WORKER_UNAVAILABLE: Project ${input.projectId} requires ${input.preferredWorkerId}`);
  }
}

/** Route every supported lifecycle through an allowlisted legacy Worker binding when available. */
export function selectWorkbenchExecutionProvider(input: WorkbenchProviderSelectionInput): WorkbenchExecutionProvider {
  // Historical synchronous API cannot load current team facts. Enabled callers
  // must use the async selector; do not accept a caller-provided admission flag.
  if (process.env.TOWER_TEAM_WORKSPACES_ENABLED === '1') throw new Error('TEAM_EXECUTOR_NOT_READY');
  return selectLegacyWorkbenchExecutionProvider(input);
}

/** Private compatibility branch, reached only after async teamless admission. */
function selectLegacyWorkbenchExecutionProvider(input: WorkbenchProviderSelectionInput): WorkbenchExecutionProvider {
  const requiredCapabilities = requiredWorkbenchWorkerCapabilities(input);
  const local = input.localProvider ?? createLocalWorkbenchExecutionProvider();
  const binding = resolveRemoteWorkbenchBinding(input.env);
  if (!binding) return local;
  planWorkbenchExecution(input.request, 'local-runtime');
  const deploymentId = input.deploymentId ?? resolveProjectEnvironmentDeploymentId(input.env);
  bootstrapLegacyRemoteWorker(binding, deploymentId, input.now);
  const preferredWorkerId = resolveDefaultWorkbenchWorkerId(input);
  let worker: WorkbenchWorkerView;
  try {
    worker = (input.selectWorker ?? selectWorkbenchWorker)({
      projectId: input.projectId,
      deploymentId,
      requiredCapabilities,
      preferredWorkerId,
    });
    assertWorkbenchDefaultWorkerSelected({
      projectId: input.projectId,
      workstationMode: input.workstationMode,
      env: input.env,
      preferredWorkerId,
      selectedWorkerId: worker.workerId,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'NO_ELIGIBLE_WORKER') return local;
    throw error;
  }
  const token = input.resolveWorkerToken?.(worker.workerId)
    ?? (worker.workerId === binding.workerId ? binding.token : null);
  if (!token) return local;
  const env = input.env ?? process.env;
  const remote = env.TOWER_REMOTE_WORKER_RSYNC_REMOTE?.trim();
  const remoteProjectRoot = env.TOWER_REMOTE_WORKER_RSYNC_PROJECT_ROOT?.trim();
  const sshKeyPath = env.TOWER_REMOTE_WORKER_RSYNC_SSH_KEY?.trim();
  const workspaceBridge = createMigrationWorkspaceBridge(input, { remote, remoteProjectRoot, sshKeyPath });
  return createRemoteWorkbenchExecutionProvider(createRemoteWorkbenchHttpTransport({
    workerId: worker.workerId,
    baseUrl: worker.baseUrl,
    token,
  }), workspaceBridge);
}

/**
 * Prefer the durable PostgreSQL Worker pool.
 *
 * IMPORTANT: legacy env fallback is migration scaffolding, not the target architecture.
 * Only "no eligible Worker" and pre-migration missing-table states may enter it. A normal
 * DB/auth/workspace error must remain visible rather than silently moving compute to Tower.
 */
export function requiredWorkbenchWorkerCapabilities(input: Pick<WorkbenchProviderSelectionInput, 'authorityMode' | 'actorRole'>): string[] {
  if (input.authorityMode === 'operator-plane') {
    throw new Error('OPERATOR_WORKER_RETIRED: Operator access uses the native Operator execution environment');
  }
  return ['job'];
}

export async function selectPersistedWorkbenchExecutionProvider(input: WorkbenchProviderSelectionInput & {
  selectPersistedWorker?: (input: { projectId: string; deploymentId?: string; requiredCapabilities: string[]; preferredWorkerId?: string; allowStalePreferredWorker?: boolean; allowCanonicalProject?: boolean }) => Promise<WorkbenchWorkerView>;
  resolvePersistedWorkerToken?: (workerId: string) => Promise<string | null> | string | null;
}): Promise<WorkbenchExecutionProvider> {
  // Enforce process policy before provider/credential selection and OUTSIDE the
  // Worker fallback catch. A supplied executionContext/env is not fresh admission.
  // No current Project-only executor enforces the team workspace mount contract.
  if (process.env.TOWER_TEAM_WORKSPACES_ENABLED === '1') {
    const team = await resolveTeamAgentContext({ userId: input.actorUserId!, agentProjectId: input.projectId });
    if (team !== null) throw new Error('TEAM_EXECUTOR_NOT_READY');
  }
  const local = input.localProvider ?? createLocalWorkbenchExecutionProvider();
  planWorkbenchExecution(input.request, 'local-runtime');
  try {
    const preferredWorkerId = resolveDefaultWorkbenchWorkerId(input);
    const deploymentId = input.deploymentId ?? resolveProjectEnvironmentDeploymentId(input.env);
    const requiredCapabilities = requiredWorkbenchWorkerCapabilities(input);
    const lifecycle = planWorkbenchExecution(input.request, 'remote-worker').lifecycle;
    const capacityWeight = classifyWorkbenchWorkerCapacityWeight(input.request, lifecycle);
    const reservesSlot = capacityWeight > 0;
    const env = input.env ?? process.env;
    const admittedEnvironment = input.executionContext;
    const environmentAuthorized = Boolean(admittedEnvironment
      && admittedEnvironment.projectId === input.projectId
      && admittedEnvironment.deploymentId === deploymentId
      && admittedEnvironment.projectRoot === input.projectRoot);
    const canonicalEnvironment = Boolean(environmentAuthorized
      && admittedEnvironment?.environmentMode === 'canonical-project-workspace');
    const legacyPinnedEnvironment = Boolean(environmentAuthorized
      && admittedEnvironment?.environmentMode === 'legacy-worker-workspace'
      && admittedEnvironment.preferredExecutorId === preferredWorkerId);
    // A Workstation Project is pinned to one durable Worker. Its heartbeat remains
    // diagnostic evidence, while the actual dispatch/accept response decides liveness.
    const allowStalePreferredWorker = Boolean(preferredWorkerId
      && (legacyPinnedEnvironment || (!input.executionContext && isWorkbenchWorkstationProject(input))));
    const worker = input.selectPersistedWorker
      ? await input.selectPersistedWorker({ projectId: input.projectId, deploymentId, requiredCapabilities, preferredWorkerId, allowStalePreferredWorker, allowCanonicalProject: canonicalEnvironment })
      : reservesSlot
        ? await reservePersistedWorkbenchWorkerSlot({
          projectId: input.projectId,
          deploymentId,
          sessionId: input.sessionId,
          requiredCapabilities,
          preferredWorkerId,
          allowStalePreferredWorker,
          weight: capacityWeight,
          ttlSeconds: Math.max((input.request.timeoutSec ?? 3_600) + 300, 600),
          allowCanonicalProject: canonicalEnvironment,
        })
        : await selectPersistedWorkbenchWorker({ projectId: input.projectId, deploymentId, requiredCapabilities, preferredWorkerId, allowStalePreferredWorker, allowCanonicalProject: canonicalEnvironment });
    assertWorkbenchDefaultWorkerSelected({
      projectId: input.projectId,
      workstationMode: input.executionContext ? legacyPinnedEnvironment : input.workstationMode,
      env: input.env,
      preferredWorkerId,
      selectedWorkerId: worker.workerId,
    });
    const binding = resolveRemoteWorkbenchBinding(input.env);
    // Worker registry presence is not execution authority. Transport authentication is
    // resolved separately and must match the exact selected Worker before remote binding.
    const persistedToken = input.resolvePersistedWorkerToken
      ? await input.resolvePersistedWorkerToken(worker.workerId)
      : input.actorUserId
        ? await resolveWorkbenchWorkerTransportToken(worker.workerId, input.actorUserId)
        : null;
    const token = persistedToken ?? (binding?.workerId === worker.workerId ? binding.token : null);
    const reservationId = 'reservationId' in worker && typeof worker.reservationId === 'string'
      ? worker.reservationId
      : undefined;
    if (!token) {
      if (reservesSlot && !input.selectPersistedWorker && reservationId) await releasePersistedWorkbenchWorkerSlot(reservationId);
      if (input.workstationMode) throw new Error(`WORKSTATION_WORKER_AUTH_UNAVAILABLE: ${worker.workerId}; the Worker is healthy but Tower cannot authorize this command; operator action is required`);
      if (input.runtimeBoxCompatibilityEnabled === false) {
        throw new Error(`PROJECT_EXECUTION_PLANE_UNAVAILABLE: Project ${input.projectId} has no authorized Worker and Runtime Box compatibility is disabled`);
      }
      return local;
    }
    return createScheduledRemoteProvider({
      ...input,
      worker,
      token,
      readinessGraceMs: allowStalePreferredWorker && worker.status === 'stale' ? 5_000 : 0,
      reservationId: reservesSlot && !input.selectPersistedWorker ? reservationId : undefined,
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const expectedSelectionFailure = error.message === 'NO_ELIGIBLE_WORKER'
      || error.message.startsWith('WORKER_BUSY:')
      || error.message.startsWith('WORKSTATION_WORKER_')
      || error.message.includes('relation "runtime_box_workbench_workers" does not exist');
    if (!expectedSelectionFailure) throw error;
    if (input.workstationMode) {
      if (error.message.startsWith('WORKSTATION_WORKER_')) throw error;
      if (error.message.startsWith('WORKER_BUSY:')) {
        throw new Error(`WORKSTATION_WORKER_BUSY: ${resolveDefaultWorkbenchWorkerId(input) ?? 'unbound'}; no eligible Worker has enough free capacity; retry after the current command finishes`);
      }
      if (error.message.includes('relation "runtime_box_workbench_workers" does not exist')) {
        throw new Error(`WORKSTATION_WORKER_REGISTRY_UNAVAILABLE: ${resolveDefaultWorkbenchWorkerId(input) ?? 'unbound'}; operator action is required`);
      }
      throw new Error(`WORKSTATION_WORKER_NOT_ELIGIBLE: ${resolveDefaultWorkbenchWorkerId(input) ?? 'unbound'}; check Worker health, Project scope, deployment, and capabilities; operator action is required`);
    }
    if (input.runtimeBoxCompatibilityEnabled === false) {
      const reason = error.message === 'NO_ELIGIBLE_WORKER'
        ? 'no eligible pooled Worker is currently healthy and available'
        : error.message.startsWith('WORKER_BUSY:')
          ? `eligible pooled Worker capacity is currently exhausted (${error.message})`
          : `pooled Worker selection failed (${error.message})`;
      throw new Error(`PROJECT_EXECUTION_PLANE_UNAVAILABLE: Project ${input.projectId} cannot run because ${reason}; Runtime Box compatibility is disabled`);
    }
    return selectLegacyWorkbenchExecutionProvider(input);
  }
}

function createScheduledRemoteProvider(input: WorkbenchProviderSelectionInput & { worker: WorkbenchWorkerView; token: string; readinessGraceMs?: number; reservationId?: string }): WorkbenchExecutionProvider {
  const env = input.env ?? process.env;
  const workspaceBridge = createMigrationWorkspaceBridge(input, {
    remote: env.TOWER_REMOTE_WORKER_RSYNC_REMOTE?.trim(),
    remoteProjectRoot: env.TOWER_REMOTE_WORKER_RSYNC_PROJECT_ROOT?.trim(),
    sshKeyPath: env.TOWER_REMOTE_WORKER_RSYNC_SSH_KEY?.trim(),
  });
  let released = false;
  const slot = input.reservationId ? {
    reserved: true,
    release: async () => {
      if (released) return;
      released = true;
      await releasePersistedWorkbenchWorkerSlot(input.reservationId!);
    },
  } : undefined;
  const provider = createRemoteWorkbenchExecutionProvider(createRemoteWorkbenchHttpTransport({
    workerId: input.worker.workerId, baseUrl: input.worker.baseUrl, token: input.token, projectRoot: input.projectRoot,
    readinessGraceMs: input.readinessGraceMs,
  }), workspaceBridge, slot);
  return slot ? { ...provider, releaseReservation: slot.release } : provider;
}

function createMigrationWorkspaceBridge(input: WorkbenchProviderSelectionInput, config: {
  remote?: string;
  remoteProjectRoot?: string;
  sshKeyPath?: string;
}) {
  if (input.executionContext?.environmentMode === 'canonical-project-workspace'
    || input.executionContext?.environmentMode === 'legacy-worker-workspace') return undefined;
  if (isWorkbenchWorkstationProject({
    projectId: input.projectId,
    workstationMode: input.workstationMode,
    env: input.env ?? process.env,
  })) return undefined;
  const workspaceValues = [input.projectRoot, config.remote, config.remoteProjectRoot, config.sshKeyPath];
  const workspaceConfigured = workspaceValues.filter(Boolean).length;
  if (workspaceConfigured !== 0 && workspaceConfigured !== workspaceValues.length) {
    throw new Error('REMOTE_WORKSPACE_CONFIG_INCOMPLETE: local root, remote, remote root, and SSH key are all required');
  }
  return workspaceConfigured === workspaceValues.length
    ? createRemoteWorkbenchRsyncBridge({
      projectId: input.projectId,
      projectRoot: input.projectRoot!,
      remote: config.remote!,
      remoteProjectRoot: config.remoteProjectRoot!,
      sshKeyPath: config.sshKeyPath!,
    })
    : undefined;
}
