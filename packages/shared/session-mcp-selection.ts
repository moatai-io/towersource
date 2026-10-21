/** Pi conversation opt-out list. Empty means all currently authorized Agent MCPs. */
export interface SessionMcpSelection {
  sessionId: string;
  projectId: string | null;
  /** False for non-Pi conversations; PATCH is rejected in that case. */
  supported: boolean;
  excludedServerNames: string[];
}

/** Full replacement. projectId optionally detects a stale/moved conversation. */
export interface UpdateSessionMcpSelection {
  excludedServerNames: string[];
  projectId?: string | null;
}

export const MCP_SERVER_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const MAX_SESSION_MCP_EXCLUSIONS = 64;

export function isMcpServerExclusionList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_SESSION_MCP_EXCLUSIONS
    && value.every(name => typeof name === 'string' && MCP_SERVER_NAME_PATTERN.test(name));
}
