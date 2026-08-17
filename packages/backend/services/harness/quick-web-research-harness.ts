/**
 * Owns: the first restricted Harness for short, source-backed public web research.
 * Public API: QUICK_WEB_RESEARCH_HARNESS.
 * See README.md.
 */

import type { ResolvedHarness } from './harness-types.js';

export const QUICK_WEB_RESEARCH_HARNESS_ID = 'quick-web-research';

/** A fail-closed web research Harness with no filesystem, MCP, or orchestration surface. */
export const QUICK_WEB_RESEARCH_HARNESS: Readonly<ResolvedHarness> = Object.freeze({
  id: QUICK_WEB_RESEARCH_HARNESS_ID,
  version: 1,
  runtimeProfileId: 'web-only',
  runtimeProfileVersion: 1,
  engine: 'pi',
  defaultModel: 'litellm-responses/smart',
  allowedModels: Object.freeze(['litellm-responses/smart']) as unknown as string[],
  prompt: Object.freeze({
    includePlatformKernel: true as const,
    includeAgentIdentity: true,
    includeProjectInstructions: false,
    includeMemory: false,
    includeSkills: false,
    fragments: Object.freeze([]) as unknown as string[],
  }),
  capabilityIds: Object.freeze(['web.fetch', 'web.search']),
  sandboxMode: 'none',
  networkMode: 'platform-default',
  source: 'database',
});
