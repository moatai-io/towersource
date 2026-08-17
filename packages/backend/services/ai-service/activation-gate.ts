/**
 * Owns: fail-closed validation that an AI Service Deployment is the exact runtime contract last evaluated.
 * Public API: assertAIServiceActivationReady, getAIServiceActivationReadiness, recordPassedRuntimeEvaluation.
 */
import { createHash } from 'node:crypto';
import { execute, queryOne } from '../../db/pg-repo.js';
import { buildHarnessRuntimeFingerprint } from '../harness/harness-fingerprint.js';
import { expectedToolNamesForCapabilities } from '../harness/capability-provider-registry.js';
import { resolvePublishedHarnessReference } from '../harness/harness-store.js';
import type { ResolvedHarness } from '../harness/harness-types.js';

export class AIServiceActivationGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIServiceActivationGateError';
  }
}

export interface AIServiceActivationReadiness {
  ok: boolean;
  reason?: string;
  code?: string;
}

function readinessCode(message: string): string {
  if (/passed Preview evaluation/i.test(message)) return 'missing_preview_evaluation';
  if (/did not pass/i.test(message)) return 'latest_evaluation_failed';
  if (/stale/i.test(message)) return 'stale_preview_evaluation';
  if (/published Harness binding|complete Harness binding|published Harness/i.test(message)) return 'invalid_harness_binding';
  if (/public-compatible|private Project context|sandbox mode|Compatibility Harness|supports Pi/i.test(message)) return 'not_public_compatible';
  if (/Deployment not found|does not belong/i.test(message)) return 'deployment_scope_error';
  return 'activation_not_ready';
}

interface DeploymentGateRow {
  service_id: string;
  status: string;
  policy_snapshot: unknown;
  source_snapshot: unknown;
  snapshot_hash: string;
}

interface EvaluationRow {
  deployment_snapshot_hash: string;
  harness_id: string;
  harness_version: number;
  runtime_profile_id: string;
  runtime_profile_version: number;
  effective_manifest_hash: string;
  prompt_bundle_hash: string | null;
  tool_set_hash: string;
  status: 'passed' | 'failed';
}

interface HarnessBinding {
  harnessId: string;
  harnessVersion: number;
  runtimeProfileId: string;
  runtimeProfileVersion: number;
  engine: 'pi' | 'claude';
  model?: string;
  status: string;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function effectiveManifestHash(harness: ResolvedHarness): string {
  const manifest = {
    id: harness.id,
    version: harness.version,
    runtimeProfileId: harness.runtimeProfileId,
    runtimeProfileVersion: harness.runtimeProfileVersion,
    engine: harness.engine,
    defaultModel: harness.defaultModel,
    allowedModels: harness.allowedModels,
    prompt: harness.prompt,
    capabilityIds: [...harness.capabilityIds].sort(),
    sandboxMode: harness.sandboxMode,
    networkMode: harness.networkMode,
  };
  return createHash('sha256').update(stable(manifest)).digest('hex');
}

function bindingFromPolicy(policySnapshot: unknown): HarnessBinding {
  const policy = policySnapshot && typeof policySnapshot === 'object' && !Array.isArray(policySnapshot)
    ? policySnapshot as Record<string, unknown>
    : {};
  const raw = policy.harnessBinding && typeof policy.harnessBinding === 'object' && !Array.isArray(policy.harnessBinding)
    ? policy.harnessBinding as Record<string, unknown>
    : null;
  if (!raw) throw new AIServiceActivationGateError('Activation requires a published Harness binding');
  const binding: HarnessBinding = {
    harnessId: String(raw.harnessId || ''),
    harnessVersion: Number(raw.harnessVersion),
    runtimeProfileId: String(raw.runtimeProfileId || ''),
    runtimeProfileVersion: Number(raw.runtimeProfileVersion),
    engine: raw.engine === 'claude' ? 'claude' : 'pi',
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
    status: typeof raw.status === 'string' ? raw.status : '',
  };
  if (!binding.harnessId || !Number.isInteger(binding.harnessVersion) || binding.harnessVersion < 1 ||
      !binding.runtimeProfileId || !Number.isInteger(binding.runtimeProfileVersion) || binding.runtimeProfileVersion < 1) {
    throw new AIServiceActivationGateError('Activation requires a complete Harness binding');
  }
  if (binding.status !== 'published') throw new AIServiceActivationGateError('Activation requires a published Harness');
  return binding;
}

function assertPublicCompatible(harness: ResolvedHarness): void {
  if (harness.engine !== 'pi') throw new AIServiceActivationGateError('Activation currently supports Pi Harnesses only');
  if (harness.source === 'legacy-default') throw new AIServiceActivationGateError('Compatibility Harness is not public-compatible');
  if (harness.sandboxMode !== 'none') throw new AIServiceActivationGateError(`Harness sandbox mode ${harness.sandboxMode} is not public-compatible`);
  if (harness.prompt.includeProjectInstructions || harness.prompt.includeMemory || harness.prompt.includeSkills) {
    throw new AIServiceActivationGateError('Harness prompt plan exposes private Project context');
  }
  // This call is also the fail-closed registry check for unknown capabilities.
  expectedToolNamesForCapabilities(harness.capabilityIds);
}

async function resolveDeploymentRuntime(deploymentId: string, expectedServiceId?: string) {
  const deployment = await queryOne<DeploymentGateRow>(
    'SELECT service_id,status,policy_snapshot,source_snapshot,snapshot_hash FROM ai_service_deployments WHERE id=$1',
    [deploymentId],
  );
  if (!deployment) throw new AIServiceActivationGateError('Deployment not found');
  if (expectedServiceId && deployment.service_id !== expectedServiceId) {
    throw new AIServiceActivationGateError('Deployment does not belong to AI service');
  }
  const binding = bindingFromPolicy(deployment.policy_snapshot);
  const harness = await resolvePublishedHarnessReference(binding);
  assertPublicCompatible(harness);
  const source = deployment.source_snapshot && typeof deployment.source_snapshot === 'object' && !Array.isArray(deployment.source_snapshot)
    ? deployment.source_snapshot as Record<string, unknown> : {};
  const knowledgeToolNames = source.kind === 'knowledge' && Array.isArray(source.refs) && source.refs.length > 0
    ? ['knowledge_read', 'knowledge_search'] : [];
  const toolNames = [...expectedToolNamesForCapabilities(harness.capabilityIds), ...knowledgeToolNames].sort();
  const fingerprint = buildHarnessRuntimeFingerprint(harness, toolNames);
  return { deployment, harness, fingerprint, manifestHash: effectiveManifestHash(harness) };
}

async function insertPassedRuntimeEvaluation(input: {
  serviceId: string;
  deploymentId: string;
  conversationId: string | null;
  evaluatedByUserId: number;
  provenance: Record<string, unknown>;
  deployment: DeploymentGateRow;
  harness: ResolvedHarness;
  fingerprint: ReturnType<typeof buildHarnessRuntimeFingerprint>;
  manifestHash: string;
}): Promise<void> {
  await execute(
    `INSERT INTO ai_service_runtime_evaluations
       (service_id,deployment_id,conversation_id,deployment_snapshot_hash,harness_id,harness_version,
        runtime_profile_id,runtime_profile_version,effective_manifest_hash,prompt_bundle_hash,tool_set_hash,status,provenance,evaluated_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'passed',$12::jsonb,$13)`,
    [input.serviceId, input.deploymentId, input.conversationId, input.deployment.snapshot_hash, input.harness.id, input.harness.version,
      input.harness.runtimeProfileId, input.harness.runtimeProfileVersion, input.manifestHash, input.fingerprint.promptBundleHash, input.fingerprint.toolSetHash,
      JSON.stringify(input.provenance), input.evaluatedByUserId],
  );
}

/** Store one passed Preview evaluation without trusting client-provided fingerprints. */
export async function recordPassedRuntimeEvaluation(input: {
  serviceId: string;
  deploymentId: string;
  conversationId: string;
  evaluatedByUserId: number;
  provenance: Record<string, unknown>;
}): Promise<void> {
  const { deployment, harness, fingerprint, manifestHash } = await resolveDeploymentRuntime(input.deploymentId, input.serviceId);
  if (input.provenance.deploymentSnapshotHash !== deployment.snapshot_hash || input.provenance.promptBundleHash !== fingerprint.promptBundleHash || input.provenance.toolSetHash !== fingerprint.toolSetHash) {
    throw new AIServiceActivationGateError('Preview provenance does not match the Deployment runtime contract');
  }
  await insertPassedRuntimeEvaluation({ ...input, deployment, harness, fingerprint, manifestHash });
}

/** One-click deploy check: validate the public runtime contract server-side and mint activation evidence without exposing review UI. */
export async function recordServerDeployCheck(input: { serviceId: string; deploymentId: string; evaluatedByUserId: number }): Promise<void> {
  const { deployment, harness, fingerprint, manifestHash } = await resolveDeploymentRuntime(input.deploymentId, input.serviceId);
  await insertPassedRuntimeEvaluation({
    serviceId: input.serviceId,
    deploymentId: input.deploymentId,
    conversationId: null,
    evaluatedByUserId: input.evaluatedByUserId,
    provenance: {
      source: 'one_click_deploy',
      deploymentSnapshotHash: deployment.snapshot_hash,
      promptBundleHash: fingerprint.promptBundleHash,
      toolSetHash: fingerprint.toolSetHash,
    },
    deployment,
    harness,
    fingerprint,
    manifestHash,
  });
}

/** Require a current passed evaluation for this exact immutable runtime contract. */
export async function assertAIServiceActivationReady(deploymentId: string, expectedServiceId?: string): Promise<void> {
  const { deployment, harness, fingerprint, manifestHash } = await resolveDeploymentRuntime(deploymentId, expectedServiceId);
  const evaluation = await queryOne<EvaluationRow>(
    `SELECT deployment_snapshot_hash,harness_id,harness_version,runtime_profile_id,runtime_profile_version,
            effective_manifest_hash,prompt_bundle_hash,tool_set_hash,status
       FROM ai_service_runtime_evaluations
      WHERE deployment_id=$1 ORDER BY evaluated_at DESC LIMIT 1`,
    [deploymentId],
  );
  if (!evaluation) throw new AIServiceActivationGateError('Activation requires a passed Preview evaluation');
  if (evaluation.status !== 'passed') throw new AIServiceActivationGateError('Latest Preview evaluation did not pass');
  const current = {
    deploymentSnapshotHash: deployment.snapshot_hash,
    harnessId: harness.id,
    harnessVersion: harness.version,
    runtimeProfileId: harness.runtimeProfileId,
    runtimeProfileVersion: harness.runtimeProfileVersion,
    effectiveManifestHash: manifestHash,
    promptBundleHash: fingerprint.promptBundleHash,
    toolSetHash: fingerprint.toolSetHash,
  };
  const evaluated = {
    deploymentSnapshotHash: evaluation.deployment_snapshot_hash,
    harnessId: evaluation.harness_id,
    harnessVersion: Number(evaluation.harness_version),
    runtimeProfileId: evaluation.runtime_profile_id,
    runtimeProfileVersion: Number(evaluation.runtime_profile_version),
    effectiveManifestHash: evaluation.effective_manifest_hash,
    promptBundleHash: evaluation.prompt_bundle_hash,
    toolSetHash: evaluation.tool_set_hash,
  };
  if (stable(current) !== stable(evaluated)) {
    throw new AIServiceActivationGateError('Preview evaluation is stale for the current Deployment runtime contract');
  }
}

/** Read-only readiness check for UI/wizard. Activation still calls assertAIServiceActivationReady. */
export async function getAIServiceActivationReadiness(deploymentId: string, expectedServiceId?: string): Promise<AIServiceActivationReadiness> {
  try {
    await assertAIServiceActivationReady(deploymentId, expectedServiceId);
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'AI Service activation is not ready';
    return { ok: false, reason, code: readinessCode(reason) };
  }
}
