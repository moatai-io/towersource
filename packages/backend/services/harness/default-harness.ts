/**
 * Owns: the compatibility Harness that represents Tower's current full Pi surface.
 * Public API: TOWER_DEFAULT_HARNESS.
 * See README.md.
 */

import type { ResolvedHarness } from './harness-types.js';

/** Existing Tower behavior expressed as a Harness contract without filtering. */
export const TOWER_DEFAULT_HARNESS: Readonly<ResolvedHarness> = Object.freeze({
  id: 'tower-default',
  version: 1,
  runtimeProfileId: 'standard',
  runtimeProfileVersion: 1,
  engine: 'pi',
  defaultModel: null,
  allowedModels: null,
  prompt: Object.freeze({
    includePlatformKernel: true as const,
    // Keep AGENTS.md as the canonical project instruction layer, but do not
    // inject Primary Agent profile or Session Identity by default. Identity is
    // available through explicit lookup/snapshots when a workflow needs it.
    includeAgentIdentity: false,
    includeProjectInstructions: true,
    includeMemory: true,
    includeSkills: true,
    fragments: Object.freeze([]) as unknown as string[],
  }),
  // Empty means "legacy full surface" only while source=legacy-default.
  // It is not an allow-none policy. Filtering begins after the capability registry lands.
  capabilityIds: Object.freeze([]),
  sandboxMode: 'platform-default',
  networkMode: 'platform-default',
  source: 'legacy-default',
});
