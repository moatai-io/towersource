/**
 * Owns: resolving one immutable Harness contract before an Agent runtime is assembled.
 * Public API: resolveHarnessForSession.
 * See README.md.
 */

import { TOWER_DEFAULT_HARNESS } from './default-harness.js';
import { QUICK_WEB_RESEARCH_HARNESS, QUICK_WEB_RESEARCH_HARNESS_ID } from './quick-web-research-harness.js';
import { queryOne } from '../../db/pg-repo.js';
import type { HarnessResolutionInput, ResolvedHarness } from './harness-types.js';
import { validateEffectiveHarnessManifest } from './harness-manifest.js';

/**
 * Resolve the Harness for one Session.
 *
 * Existing Sessions preserve tower-default@v1 unless the caller explicitly
 * requests a published Harness. Unknown Harness ids fail closed.
 */
export async function resolveHarnessForSession(input: HarnessResolutionInput): Promise<ResolvedHarness> {
  if (!input.sessionId.trim()) {
    throw new Error('Harness resolution requires a Session identity');
  }

  let harness: Readonly<ResolvedHarness> | null = input.requestedHarnessId === QUICK_WEB_RESEARCH_HARNESS_ID
    ? QUICK_WEB_RESEARCH_HARNESS
    : input.requestedHarnessId === undefined || input.requestedHarnessId === TOWER_DEFAULT_HARNESS.id
      ? TOWER_DEFAULT_HARNESS
      : null;
  if (!harness && input.requestedHarnessId && input.requestedHarnessVersion !== undefined) {
    const row = await queryOne<{ effective_manifest: unknown }>(
      `SELECT effective_manifest FROM harness_versions
        WHERE harness_id=$1 AND version=$2 AND status='published'`,
      [input.requestedHarnessId, input.requestedHarnessVersion],
    );
    const candidate = row?.effective_manifest;
    if (candidate) harness = Object.freeze({ ...validateEffectiveHarnessManifest(candidate), source: 'database' as const });
  }
  if (!harness) throw new Error(`Unknown Harness ${input.requestedHarnessId}`);
  if (input.requestedHarnessVersion !== undefined && input.requestedHarnessVersion !== harness.version) {
    throw new Error(`Unknown Harness version ${harness.id}@${input.requestedHarnessVersion}`);
  }
  if (input.requestedRuntimeProfileId !== undefined && input.requestedRuntimeProfileId !== harness.runtimeProfileId) {
    throw new Error(`Harness ${harness.id}@${harness.version} does not provide Runtime Profile ${input.requestedRuntimeProfileId}`);
  }
  if (input.requestedRuntimeProfileVersion !== undefined && input.requestedRuntimeProfileVersion !== harness.runtimeProfileVersion) {
    throw new Error(`Unknown Runtime Profile version ${harness.runtimeProfileId}@${input.requestedRuntimeProfileVersion}`);
  }

  if (input.requestedEngine !== harness.engine) {
    throw new Error(`Harness ${harness.id}@${harness.version} does not support engine ${input.requestedEngine}`);
  }
  if (input.requestedModel && harness.allowedModels && !harness.allowedModels.includes(input.requestedModel)) {
    throw new Error(`Harness ${harness.id}@${harness.version} does not allow model ${input.requestedModel}`);
  }

  if (input.invocationKind === 'channel') {
    const channel = input.channel;
    if (!channel) throw new Error('Channel Harness resolution requires invocation context');
    if (!channel.channelId.trim() || !channel.agentProjectId.trim()) {
      throw new Error('Channel Harness resolution requires channel and Agent identity');
    }
    if (!Number.isInteger(channel.invokingUserId) || channel.invokingUserId <= 0) {
      throw new Error('Channel Harness resolution requires an invoking user');
    }
    if (channel.agentProjectId !== input.projectId) {
      throw new Error('Channel Agent binding does not match the requested Project');
    }
  }

  return harness;
}
