/**
 * Owns: server-side validation and canonicalization of Harness bindings embedded in AI Service deployments.
 * Public API: canonicalizeServiceHarnessPolicy.
 */
import { queryOne } from '../../db/pg-repo.js';
import { resolveHarnessForSession } from '../harness/harness-resolver.js';
import { expectedToolNamesForCapabilities } from '../harness/capability-provider-registry.js';

interface HarnessBindingInput {
  harnessId?: unknown;
  harnessVersion?: unknown;
  runtimeProfileId?: unknown;
  runtimeProfileVersion?: unknown;
  engine?: unknown;
  model?: unknown;
  status?: unknown;
}

function asPositiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

/**
 * Replace client-asserted Harness/tool fields with a Registry-verified canonical contract.
 * P0 supports only published builtin manifests whose runtime implementation can be resolved exactly.
 */
export async function canonicalizeServiceHarnessPolicy(policySnapshot: unknown): Promise<Record<string, unknown>> {
  if (!policySnapshot || typeof policySnapshot !== 'object' || Array.isArray(policySnapshot)) {
    throw new Error('policySnapshot must be an object');
  }
  const policy = policySnapshot as Record<string, unknown>;
  const binding = policy.harnessBinding as HarnessBindingInput | undefined;
  if (!binding || typeof binding !== 'object') throw new Error('Published Harness binding required');

  const harnessId = typeof binding.harnessId === 'string' ? binding.harnessId.trim() : '';
  const runtimeProfileId = typeof binding.runtimeProfileId === 'string' ? binding.runtimeProfileId.trim() : '';
  const engine = binding.engine === 'pi' || binding.engine === 'claude' ? binding.engine : null;
  const model = typeof binding.model === 'string' ? binding.model.trim() : '';
  if (!harnessId || !runtimeProfileId || !engine) throw new Error('Complete Harness binding required');
  if (binding.status !== 'published') throw new Error('Only a published Harness can be deployed');

  const harnessVersion = asPositiveInteger(binding.harnessVersion, 'harnessVersion');
  const runtimeProfileVersion = asPositiveInteger(binding.runtimeProfileVersion, 'runtimeProfileVersion');
  const registry = await queryOne<{
    harness_status: string;
    profile_status: string;
    engine: string;
    profile_version: number;
  }>(
    `SELECT h.status AS harness_status, p.status AS profile_status, v.engine, p.profile_version
       FROM harnesses h
       JOIN harness_versions v ON v.harness_id = h.id AND v.version = $2 AND v.status = 'published'
       JOIN harness_runtime_profile_versions p
         ON p.profile_id = $3 AND p.harness_id = h.id AND p.harness_version = v.version
      WHERE h.id = $1`,
    [harnessId, harnessVersion, runtimeProfileId],
  );
  if (!registry || registry.harness_status !== 'active' || registry.profile_status !== 'active') {
    throw new Error(`Published Harness not found: ${harnessId}@${harnessVersion}/${runtimeProfileId}@${runtimeProfileVersion}`);
  }
  if (Number(registry.profile_version) !== runtimeProfileVersion || registry.engine !== engine) {
    throw new Error('Harness binding does not match the published Registry tuple');
  }

  const resolved = await resolveHarnessForSession({
    sessionId: 'ai-service-deployment-validation',
    requestedEngine: engine,
    requestedModel: model || undefined,
    requestedHarnessId: harnessId,
    requestedHarnessVersion: harnessVersion,
    requestedRuntimeProfileId: runtimeProfileId,
    requestedRuntimeProfileVersion: runtimeProfileVersion,
  });
  // The deployment inherits the complete concrete tool surface compiled from
  // the published Harness. The client may show a preview, but it cannot omit or
  // hand-pick tools from the pinned Harness contract.
  const allowedTools = expectedToolNamesForCapabilities(resolved.capabilityIds);

  return {
    ...policy,
    harnessBinding: {
      harnessId: resolved.id,
      harnessVersion: resolved.version,
      runtimeProfileId: resolved.runtimeProfileId,
      runtimeProfileVersion: resolved.runtimeProfileVersion,
      engine: resolved.engine,
      model: model || resolved.defaultModel,
      status: 'published',
    },
    allowedTools,
    capabilityIds: [...resolved.capabilityIds].sort(),
  };
}
