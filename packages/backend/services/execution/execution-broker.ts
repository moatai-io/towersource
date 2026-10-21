import { chooseExecutionLifecycle } from './lifecycle-policy.js';
import { isManagedDownloadCommand } from './downloads/download-contract.js';
/**
 * Owns: Provider-neutral Workbench execution routing skeleton.
 * Public API: planWorkbenchExecution, executeWorkbenchRequest, WorkbenchExecutionProvider.
 *
 * This first vertical slice reuses existing Local Runtime command/service primitives.
 * Durable jobs and remote workers plug into the same provider contract later.
 */

import { classifyCommand, extractPortFromCommand } from './command-classifier.js';
import type { ExecResult, ServiceRow } from './types.js';
import type { WorkbenchJobRow } from './jobs/job-registry.js';
import { authorizeTowerAction, type TowerRole } from '../authority/authorization-policy.js';
import { resolveProjectAgentExecutionIdentity, type AgentExecutionIdentity } from '../authority/agent-execution-policy.js';

export type WorkbenchExecutionLifecycle = 'foreground' | 'job' | 'service';
export type WorkbenchExecutionProviderKind = 'local-runtime' | 'remote-worker';

export interface WorkbenchExecutionRequest {
  /** Exact env names requested by a wrapper; not a grant and never secret values. */
  credentialRequirements?: string[];
  /** Select a Google connection for indirect CLI calls; project policy still applies. */
  gwsConnectionId?: string;
  command: string;
  cwd?: string;
  lifecycle?: 'auto' | WorkbenchExecutionLifecycle;
  timeoutSec?: number;
  env?: Record<string, string>;
  service?: {
    name?: string;
    port?: number;
    pinned?: boolean;
    purpose?: string;
    ttlHours?: number;
  };
}

export interface WorkbenchExecutionPlan {
  lifecycle: WorkbenchExecutionLifecycle;
  providerKind: WorkbenchExecutionProviderKind;
  reason: string;
  risk: 'normal' | 'review';
  serviceName?: string;
  port?: number;
  limitations: string[];
}

export type WorkbenchForegroundOutcomeCode = 'SUCCEEDED' | 'TIMEOUT' | 'OOM_KILLED' | 'NON_ZERO_EXIT';

export interface WorkbenchForegroundOutcome {
  ok: boolean;
  code: WorkbenchForegroundOutcomeCode;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  oomKilled: boolean;
}

export type WorkbenchExecutionResult =
  | { lifecycle: 'foreground'; providerKind: WorkbenchExecutionProviderKind; outcome: WorkbenchForegroundOutcome; result: ExecResult }
  | { lifecycle: 'job'; providerKind: WorkbenchExecutionProviderKind; durable: true; job: WorkbenchJobRow }
  | { lifecycle: 'service'; providerKind: WorkbenchExecutionProviderKind; service: ServiceRow };

export interface WorkbenchExecutionContext {
  projectId: string;
  userId: number;
  sessionId: string;
  userRole?: TowerRole | string;
  projectMember?: boolean;
  projectWritable?: boolean;
  projectOwner?: boolean;
  /** Server-resolved only; public command payloads must not supply authority. */
  executionScope?: 'project' | 'organization';
}

/** Requester id is retained for audit/entrance checks, never a provider credential selector. */
export type WorkbenchProviderExecutionContext = Pick<WorkbenchExecutionContext, 'projectId' | 'userId' | 'sessionId'>;

/** Provider seam shared by current Local Runtime and future Remote Worker adapters. */
export interface WorkbenchExecutionProvider {
  kind: WorkbenchExecutionProviderKind;
  /** Release selection-time capacity when broker validation fails before provider execution starts. */
  releaseReservation?(): Promise<void>;
  executeForeground(input: WorkbenchProviderExecutionContext & WorkbenchExecutionRequest & { signal?: AbortSignal }): Promise<ExecResult>;
  enqueueJob(input: WorkbenchProviderExecutionContext & WorkbenchExecutionRequest): Promise<WorkbenchJobRow>;
  startService(input: WorkbenchProviderExecutionContext & WorkbenchExecutionRequest & {
    service: NonNullable<WorkbenchExecutionRequest['service']> & { name: string };
  }): Promise<ServiceRow>;
}

/** Select lifecycle without starting a process. Explicit lifecycle always wins. */
export function planWorkbenchExecution(
  request: WorkbenchExecutionRequest,
  providerKind: WorkbenchExecutionProviderKind = 'local-runtime',
): WorkbenchExecutionPlan {
  if (!request.command.trim()) throw new Error('Workbench execution command is required');
  const classification = classifyCommand(request.command);
  const explicit = request.lifecycle && request.lifecycle !== 'auto' ? request.lifecycle : null;
  const lifecycle: WorkbenchExecutionLifecycle = chooseExecutionLifecycle({
    explicit: explicit ?? undefined, managedDownload: isManagedDownloadCommand(request.command), classification,
  });
  const serviceName = lifecycle === 'service'
    ? request.service?.name ?? classification.suggested_service_name ?? 'service'
    : undefined;
  if (serviceName && !/^[a-z][a-z0-9-]{0,63}$/.test(serviceName)) throw new Error('Workbench service name must be lowercase alphanumeric with hyphens');
  if (request.service?.pinned && !request.service.purpose?.trim()) throw new Error('Pinned Workbench service requires a purpose');
  return {
    lifecycle,
    providerKind,
    // Lifecycle selection must not hide the reason a command requires review.
    reason: classification.cls === 'risky'
      ? classification.reason
      : explicit ? `Explicit lifecycle override: ${explicit}` : classification.reason,
    risk: classification.cls === 'risky' ? 'review' : 'normal',
    serviceName,
    port: lifecycle === 'service' ? request.service?.port ?? extractPortFromCommand(request.command) : undefined,
    limitations: lifecycle === 'job'
      ? providerKind === 'remote-worker'
        ? ['Remote Job replay and worker-loss adoption are disabled; an expired runner lease fails closed.']
        : ['Local execution is recorded durably, but running-process takeover after backend loss is not implemented yet.']
      : [],
  };
}

/** Normalize foreground process termination into the same bounded error taxonomy used by durable Jobs. */
export function summarizeWorkbenchForegroundResult(result: ExecResult): WorkbenchForegroundOutcome {
  const code: WorkbenchForegroundOutcomeCode = result.timed_out
    ? 'TIMEOUT'
    : result.oom_killed
      ? 'OOM_KILLED'
      : result.exit_code === 0
        ? 'SUCCEEDED'
        : 'NON_ZERO_EXIT';
  return {
    ok: code === 'SUCCEEDED',
    code,
    exitCode: result.exit_code,
    durationMs: result.duration_ms,
    timedOut: result.timed_out,
    oomKilled: result.oom_killed,
  };
}

/** Execute one request through the selected provider lifecycle. */
export async function executeWorkbenchRequest(input: {
  request: WorkbenchExecutionRequest;
  context: WorkbenchExecutionContext;
  provider: WorkbenchExecutionProvider;
  /** In-process foreground cancellation; never serialized into a command request. */
  signal?: AbortSignal;
}): Promise<{ plan: WorkbenchExecutionPlan; execution: WorkbenchExecutionResult; executionIdentity: AgentExecutionIdentity }> {
  let executionIdentity: AgentExecutionIdentity;
  let plan: WorkbenchExecutionPlan;
  try {
    executionIdentity = resolveProjectAgentExecutionIdentity(input.context);
    plan = planWorkbenchExecution(input.request, input.provider.kind);
  } catch (error) {
    await input.provider.releaseReservation?.();
    throw error;
  }
  const authority = authorizeTowerAction({
    role: input.context.userRole ?? 'member',
    resource: 'worker',
    action: 'execute',
    facts: {
      projectMember: input.context.projectMember ?? true,
      projectWritable: input.context.projectWritable,
      projectOwner: input.context.projectOwner,
      executionScope: input.context.executionScope,
    },
  });
  if (!authority.allowed) {
    await input.provider.releaseReservation?.();
    throw new Error(`WORKBENCH_EXECUTION_DENIED (${authority.policyId}/${authority.reason}): ${authority.requiredCapability} required`);
  }
  if (plan.risk === 'review') {
    await input.provider.releaseReservation?.();
    throw new Error(`Workbench execution requires review: ${plan.reason}`);
  }
  // Allowlist request fields rather than spreading an untrusted runtime object.
  // In particular, extra projectId/userId/sessionId/userRole fields cannot replace
  // the server context or leak human control-plane roles into provider execution.
  const providerInput: WorkbenchProviderExecutionContext & WorkbenchExecutionRequest = {
    projectId: executionIdentity.principal.projectId,
    userId: executionIdentity.requester.userId,
    sessionId: executionIdentity.requester.sessionId,
    command: input.request.command,
    cwd: input.request.cwd,
    lifecycle: input.request.lifecycle,
    timeoutSec: input.request.timeoutSec,
    env: input.request.env,
    credentialRequirements: input.request.credentialRequirements,
    gwsConnectionId: input.request.gwsConnectionId,
    service: input.request.service,
  };
  if (plan.lifecycle === 'service') {
    const service = await input.provider.startService({
      ...providerInput,
      service: { ...input.request.service, name: plan.serviceName! },
    });
    return { plan, executionIdentity, execution: { lifecycle: 'service', providerKind: input.provider.kind, service } };
  }
  if (plan.lifecycle === 'job') {
    const job = await input.provider.enqueueJob(providerInput);
    return { plan, executionIdentity, execution: { lifecycle: 'job', providerKind: input.provider.kind, durable: true, job } };
  }
  const result = await input.provider.executeForeground({ ...providerInput, signal: input.signal });
  return {
    plan,
    executionIdentity,
    execution: {
      lifecycle: 'foreground',
      providerKind: input.provider.kind,
      outcome: summarizeWorkbenchForegroundResult(result),
      result,
    },
  };
}
