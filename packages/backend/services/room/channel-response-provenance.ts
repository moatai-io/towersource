/**
 * Owns: fail-closed publication checks for shared-channel Agent responses.
 * Public API: validateChannelResponseProvenance(), CHANNEL_SAFE_TOOL_NAMES.
 */

/** Tools whose data source is either audience-scoped filesystem access or public web data. */
export const CHANNEL_SAFE_TOOL_NAMES = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'Find',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
]);

export interface ChannelToolProvenance {
  name: string;
  input?: Record<string, unknown>;
}

export interface ChannelResponseProvenance {
  authorityFingerprint: string;
  tools: ChannelToolProvenance[];
}

export interface ChannelProvenanceValidation {
  allowed: boolean;
  reason?: string;
}

/** Normalize Claude/Pi tool naming into the names consumed by ToolGuard. */
export function normalizeChannelToolName(name: string): string {
  if (!name.includes('_')) return name.charAt(0).toUpperCase() + name.slice(1);
  return name
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Verify that the completed response was produced under the current authority
 * snapshot and did not attempt a tool whose data cannot be shared with the
 * whole channel audience.
 */
export function validateChannelResponseProvenance(input: {
  expectedAuthorityFingerprint: string;
  provenance?: ChannelResponseProvenance;
}): ChannelProvenanceValidation {
  const { expectedAuthorityFingerprint, provenance } = input;
  if (!provenance) return { allowed: false, reason: 'missing execution provenance' };
  if (!expectedAuthorityFingerprint || provenance.authorityFingerprint !== expectedAuthorityFingerprint) {
    return { allowed: false, reason: 'channel authority changed during execution' };
  }
  for (const tool of provenance.tools) {
    const normalized = normalizeChannelToolName(tool.name);
    if (!CHANNEL_SAFE_TOOL_NAMES.has(normalized)) {
      return { allowed: false, reason: `tool is not audience-safe: ${normalized || 'unknown'}` };
    }
  }
  return { allowed: true };
}
