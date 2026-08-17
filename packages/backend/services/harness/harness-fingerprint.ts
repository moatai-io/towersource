/**
 * Owns: deterministic, secret-free fingerprints for resolved Harness tool surfaces.
 * Public API: buildHarnessRuntimeFingerprint.
 * See README.md.
 */

import { createHash } from 'node:crypto';
import type { HarnessRuntimeFingerprint, ResolvedHarness } from './harness-types.js';
import { promptBundleHash } from './prompt-component-registry.js';

/** Build a stable, secret-free fingerprint from immutable prompt and tool contracts. */
export function buildHarnessRuntimeFingerprint(
  harness: ResolvedHarness,
  toolNames: readonly string[],
): HarnessRuntimeFingerprint {
  const normalizedToolNames = [...new Set(toolNames)].sort((a, b) => a.localeCompare(b));
  const toolSetHash = createHash('sha256').update(JSON.stringify(normalizedToolNames)).digest('hex');
  return {
    harnessId: harness.id,
    harnessVersion: harness.version,
    runtimeProfileId: harness.runtimeProfileId,
    runtimeProfileVersion: harness.runtimeProfileVersion,
    engine: harness.engine,
    resolutionSource: harness.source,
    promptBundleHash: harness.prompt.bundleHash || promptBundleHash(harness.prompt),
    toolSetHash,
    toolCount: normalizedToolNames.length,
  };
}
