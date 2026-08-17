import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryOne = vi.fn();
const execute = vi.fn();
const resolvePublishedHarnessReference = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({ queryOne, execute }));
vi.mock('../harness/harness-store.js', () => ({ resolvePublishedHarnessReference }));

const { assertAIServiceActivationReady, effectiveManifestHash, getAIServiceActivationReadiness, recordPassedRuntimeEvaluation, recordServerDeployCheck } = await import('./activation-gate.js');

const harness = Object.freeze({
  id: 'quick-web-research', version: 1, runtimeProfileId: 'web-only', runtimeProfileVersion: 1,
  engine: 'pi' as const, defaultModel: 'litellm-responses/smart', allowedModels: ['litellm-responses/smart'],
  prompt: { includePlatformKernel: true as const, includeAgentIdentity: true, includeProjectInstructions: false, includeMemory: false, includeSkills: false, fragments: [] },
  capabilityIds: ['web.fetch', 'web.search'], sandboxMode: 'none' as const, networkMode: 'platform-default' as const, source: 'database' as const,
});
const deployment = {
  service_id: 'svc-1', status: 'approved', snapshot_hash: 'snapshot-1',
  policy_snapshot: { harnessBinding: { harnessId: 'quick-web-research', harnessVersion: 1, runtimeProfileId: 'web-only', runtimeProfileVersion: 1, engine: 'pi', model: 'litellm-responses/smart', status: 'published' } },
};

function passedEvaluation(overrides: Record<string, unknown> = {}) {
  return {
    deployment_snapshot_hash: 'snapshot-1', harness_id: 'quick-web-research', harness_version: 1,
    runtime_profile_id: 'web-only', runtime_profile_version: 1,
    effective_manifest_hash: effectiveManifestHash(harness), prompt_bundle_hash: 'prompt-hash', tool_set_hash: 'tool-hash', status: 'passed', ...overrides,
  };
}

describe('AI Service activation gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolvePublishedHarnessReference.mockResolvedValue(harness);
  });

  it('allows the exact Deployment and runtime fingerprint that passed evaluation', async () => {
    const { buildHarnessRuntimeFingerprint } = await import('../harness/harness-fingerprint.js');
    const { expectedToolNamesForCapabilities } = await import('../harness/capability-provider-registry.js');
    const fingerprint = buildHarnessRuntimeFingerprint(harness, expectedToolNamesForCapabilities(harness.capabilityIds));
    queryOne.mockResolvedValueOnce(deployment).mockResolvedValueOnce(passedEvaluation({ prompt_bundle_hash: fingerprint.promptBundleHash, tool_set_hash: fingerprint.toolSetHash }));
    await expect(assertAIServiceActivationReady('dep-1', 'svc-1')).resolves.toBeUndefined();
  });

  it('rejects activation without a passed Preview evaluation', async () => {
    queryOne.mockResolvedValueOnce(deployment).mockResolvedValueOnce(undefined);
    await expect(assertAIServiceActivationReady('dep-1', 'svc-1')).rejects.toThrow('requires a passed Preview evaluation');
  });

  it('returns structured read-only readiness reasons for the wizard', async () => {
    queryOne.mockResolvedValueOnce(deployment).mockResolvedValueOnce(undefined);
    await expect(getAIServiceActivationReadiness('dep-1', 'svc-1')).resolves.toMatchObject({ ok: false, code: 'missing_preview_evaluation', reason: expect.stringContaining('passed Preview evaluation') });
  });

  it('rejects a stale Deployment or Tool fingerprint', async () => {
    queryOne.mockResolvedValueOnce(deployment).mockResolvedValueOnce(passedEvaluation({ deployment_snapshot_hash: 'old-snapshot' }));
    await expect(assertAIServiceActivationReady('dep-1', 'svc-1')).rejects.toThrow('evaluation is stale');
  });

  it('rejects a stale Prompt Bundle fingerprint', async () => {
    queryOne.mockResolvedValueOnce(deployment).mockResolvedValueOnce(passedEvaluation({ prompt_bundle_hash: 'old-prompt-bundle' }));
    await expect(assertAIServiceActivationReady('dep-1', 'svc-1')).rejects.toThrow('evaluation is stale');
  });

  it('rejects private-context Harnesses even when published', async () => {
    resolvePublishedHarnessReference.mockResolvedValue({ ...harness, prompt: { ...harness.prompt, includeMemory: true } });
    queryOne.mockResolvedValueOnce(deployment);
    await expect(assertAIServiceActivationReady('dep-1', 'svc-1')).rejects.toThrow('private Project context');
  });

  it('records passed evaluation fingerprints from server-resolved provenance', async () => {
    const { buildHarnessRuntimeFingerprint } = await import('../harness/harness-fingerprint.js');
    const { expectedToolNamesForCapabilities } = await import('../harness/capability-provider-registry.js');
    const fingerprint = buildHarnessRuntimeFingerprint(harness, expectedToolNamesForCapabilities(harness.capabilityIds));
    queryOne.mockResolvedValueOnce(deployment);
    execute.mockResolvedValue({ changes: 1 });
    await recordPassedRuntimeEvaluation({ serviceId: 'svc-1', deploymentId: 'dep-1', conversationId: 'conv-1', evaluatedByUserId: 7, provenance: { deploymentSnapshotHash: 'snapshot-1', promptBundleHash: fingerprint.promptBundleHash, toolSetHash: fingerprint.toolSetHash } });
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('prompt_bundle_hash'), expect.arrayContaining(['svc-1', 'dep-1', 'conv-1', 'snapshot-1', 'quick-web-research', 1, 'web-only', 1, fingerprint.promptBundleHash, fingerprint.toolSetHash]));
  });

  it('records a server-side one-click deploy check without a fake conversation id', async () => {
    queryOne.mockResolvedValueOnce(deployment);
    execute.mockResolvedValue({ changes: 1 });
    await recordServerDeployCheck({ serviceId: 'svc-1', deploymentId: 'dep-1', evaluatedByUserId: 7 });
    const args = execute.mock.calls[0][1];
    expect(args).toEqual(expect.arrayContaining(['svc-1', 'dep-1', null, 'snapshot-1']));
    expect(String(args[11])).toContain('one_click_deploy');
  });
});
