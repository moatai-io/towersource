/**
 * Owns: Provider-neutral Workbench execution routing skeleton.
 * Public API: planWorkbenchExecution, executeWorkbenchRequest, WorkbenchExecutionProvider.
 *
 * This first vertical slice reuses existing Local Runtime command/service primitives.
 * Durable jobs and remote workers plug into the same provider contract later.
 */

import { classifyCommand, extractPortFromCommand } from './command-classifier.js';
import type { ExecResult, ServiceRow } from './types.js';
import type { WorkbenchJobRow } from './workbench-job-registry.js';

export type WorkbenchExecutionLifecycle = 'foreground' | 'job' | 'service';
export type WorkbenchExecutionProviderKind = 'local-runtime' | 'remote-worker';

export interface WorkbenchExecutionRequest {
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
}

/** Provider seam shared by current Local Runtime and future Remote Worker adapters. */
export interface WorkbenchExecutionProvider {
  kind: WorkbenchExecutionProviderKind;
  executeForeground(input: WorkbenchExecutionContext & WorkbenchExecutionRequest): Promise<ExecResult>;
  enqueueJob(input: WorkbenchExecutionContext & WorkbenchExecutionRequest): Promise<WorkbenchJobRow>;
  startService(input: WorkbenchExecutionContext & WorkbenchExecutionRequest & {
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
  const lifecycle: WorkbenchExecutionLifecycle = explicit
    ?? (classification.cls === 'long-running' ? 'service' : classification.cls === 'heavy' ? 'job' : 'foreground');
  const serviceName = lifecycle === 'service'
    ? request.service?.name ?? classification.suggested_service_name ?? 'service'
    : undefined;
  if (serviceName && !/^[a-z][a-z0-9-]{0,63}$/.test(serviceName)) throw new Error('Workbench service name must be lowercase alphanumeric with hyphens');
  if (request.service?.pinned && !request.service.purpose?.trim()) throw new Error('Pinned Workbench service requires a purpose');
  return {
    lifecycle,
    providerKind,
    reason: explicit ? `Explicit lifecycle override: ${explicit}` : classification.reason,
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
}): Promise<{ plan: WorkbenchExecutionPlan; execution: WorkbenchExecutionResult }> {
  const plan = planWorkbenchExecution(input.request, input.provider.kind);
  if (plan.risk === 'review') throw new Error(`Workbench execution requires review: ${plan.reason}`);
  if (plan.lifecycle === 'service') {
    const service = await input.provider.startService({
      ...input.context,
      ...input.request,
      service: { ...input.request.service, name: plan.serviceName! },
    });
    return { plan, execution: { lifecycle: 'service', providerKind: input.provider.kind, service } };
  }
  if (plan.lifecycle === 'job') {
    const job = await input.provider.enqueueJob({ ...input.context, ...input.request });
    return { plan, execution: { lifecycle: 'job', providerKind: input.provider.kind, durable: true, job } };
  }
  const result = await input.provider.executeForeground({ ...input.context, ...input.request });
  return {
    plan,
    execution: {
      lifecycle: 'foreground',
      providerKind: input.provider.kind,
      outcome: summarizeWorkbenchForegroundResult(result),
      result,
    },
  };
}
