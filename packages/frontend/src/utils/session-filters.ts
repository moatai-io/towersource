/**
 * Pure predicate functions for session isolation on the frontend.
 * Extracted from useChatRuntime.ts and InputBox.tsx for testability.
 */

/**
 * Should we drop an incoming SDK message because it belongs to a different session?
 * Returns true if the message should be dropped.
 */
export function shouldDropSessionMessage(
  currentSessionId: string | null,
  incomingSessionId: string | undefined,
  visibleSessionId?: string | null,
): boolean {
  // The visible session is authoritative during transcript hydration. chatStore
  // can briefly be null/stale while switching, but background turn broadcasts
  // must never claim that gap and inject their messages into the visible list.
  if (visibleSessionId) return visibleSessionId !== incomingSessionId;
  // No visible/current session (first connection) — accept everything.
  if (!currentSessionId) return false;
  return currentSessionId !== incomingSessionId;
}

/**
 * Should the assistant ref be reset because the session changed?
 * Returns true if the incoming session differs from the ref's tracked session.
 */
export function shouldResetAssistantRef(
  refSessionId: string | null,
  incomingSessionId: string,
): boolean {
  if (!refSessionId) return false;
  return refSessionId !== incomingSessionId;
}

/**
 * Should a queued message be auto-sent?
 * Returns false if streaming is still active or if the queued session doesn't match the current.
 * An empty queuedSessionId (from new-session first turn) always matches.
 */
export function shouldAutoSendQueue(
  isStreaming: boolean,
  queuedSessionId: string,
  currentSessionId: string | null,
): boolean {
  if (isStreaming) return false;
  // Empty queued session = queued during first turn before session was assigned → allow
  if (!queuedSessionId) return true;
  return currentSessionId === queuedSessionId;
}

// ── Auto-name routing ──────────────────────────────────────────────
// Extracted from useChatRuntime.ts sdk_done handler for testability.

export interface AutoNameContext {
  /** sessionId from sdk_done event (where messages actually live) */
  doneSessionId: string | undefined;
  /** sessionStore.activeSessionId (may differ due to race conditions) */
  activeSessionId: string | null;
  /** session name from sessionStore for the resolved session */
  sessionName: string | undefined;
  /** whether chatStore has at least one user message */
  hasUserMsg: boolean;
  /** whether chatStore has at least one assistant message */
  hasAssistantMsg: boolean;
}

/**
 * Decide which session ID to use for auto-naming, and whether to trigger it.
 * Returns the sessionId to auto-name, or null if auto-naming should be skipped.
 *
 * Key invariant: prefer doneSessionId (from backend) over activeSessionId
 * because messages are stored under doneSessionId. Using activeSessionId
 * caused a bug where auto-name queried an empty orphan session.
 */
export function resolveAutoNameTarget(ctx: AutoNameContext): string | null {
  const targetId = ctx.doneSessionId || ctx.activeSessionId;
  if (!targetId) return null;

  // Only auto-name sessions with default timestamp names
  const isDefaultName = ctx.sessionName?.startsWith('Session ');
  if (!isDefaultName) return null;

  // Need at least one exchange to generate a meaningful title
  if (!ctx.hasUserMsg || !ctx.hasAssistantMsg) return null;

  return targetId;
}

// ── sendMessage session resolution ─────────────────────────────────
// Extracted from useChatRuntime.ts sendMessage for testability.

/**
 * Resolve which sessionId to use when sending a message.
 *
 * The visible session is `sessionStore.activeSessionId`; `chatStore.sessionId`
 * is the currently loaded transcript. During fast lifecycle transitions such as
 * duplicate-session → auto-select clone, those two stores can briefly diverge.
 * If they disagree, prefer the visible active session so the user's first send
 * goes to the session they are looking at instead of a stale transcript owner.
 * Returns { sessionId, source } or null if no session is available.
 */
export function resolveSendSessionId(
  chatStoreSessionId: string | null,
  sessionStoreActiveId: string | null,
): { sessionId: string; source: 'chatStore' | 'sessionStore' } | null {
  if (chatStoreSessionId && sessionStoreActiveId && chatStoreSessionId !== sessionStoreActiveId) {
    return { sessionId: sessionStoreActiveId, source: 'sessionStore' };
  }
  if (chatStoreSessionId) {
    return { sessionId: chatStoreSessionId, source: 'chatStore' };
  }
  if (sessionStoreActiveId) {
    return { sessionId: sessionStoreActiveId, source: 'sessionStore' };
  }
  return null;
}

// ── Session deduplication ──────────────────────────────────────────
// Extracted from session-store.ts for testability.

export interface SessionLike {
  id: string;
  [key: string]: any;
}

/**
 * Deduplicate sessions by ID, keeping the first occurrence.
 * Used by setSessions (server data) and addSession (single add).
 */
export function dedupeSessionsById<T extends SessionLike>(sessions: T[]): T[] {
  const seen = new Set<string>();
  return sessions.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

/**
 * Add a session only if its ID doesn't already exist in the list.
 * Returns the original array (same reference) if duplicate — important for React.
 */
export function addSessionIfNew<T extends SessionLike>(
  existing: T[],
  newSession: T,
): T[] {
  if (existing.some((s) => s.id === newSession.id)) return existing;
  return [newSession, ...existing];
}

// ── Resume session resolution ──────────────────────────────────────
// Extracted from ws-handler.ts handleChat for testability.

/**
 * Resolve which claudeSessionId to use for SDK resume.
 * Client-provided value takes priority (fresh), DB value is fallback (may be stale).
 * Returns undefined for a brand-new session (no resume).
 */
export function resolveResumeSessionId(
  clientProvidedId: string | undefined | null,
  dbStoredId: string | undefined | null,
): string | undefined {
  return clientProvidedId || dbStoredId || undefined;
}

/**
 * Detect server restart by comparing epoch values.
 * Returns true if the server has restarted since last connection.
 */
export function isServerRestarted(
  previousEpoch: string | null,
  newEpoch: string | null | undefined,
): boolean {
  if (!previousEpoch) return false; // First connection, not a restart
  if (!newEpoch) return false;       // No epoch info
  return previousEpoch !== newEpoch;
}

// ── JSONL path & DB↔JSONL sync validation ────────────────────────
// Extracted from session-manager.ts cleanupStaleSessions for testability.

export interface DbSessionRecord {
  id: string;
  claude_session_id: string;
  cwd: string;
}

/**
 * Encode a cwd path to the format Claude CLI uses for project directories.
 * e.g. "/home/user/project" → "-home-user-project"
 */
export function encodeCwdForClaudePath(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

/**
 * Build the expected JSONL file path for a session.
 * This mirrors the path Claude CLI uses: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 */
export function buildJsonlPath(homeDir: string, cwd: string, claudeSessionId: string): string {
  const encodedCwd = encodeCwdForClaudePath(cwd);
  return `${homeDir}/.claude/projects/${encodedCwd}/${claudeSessionId}.jsonl`;
}

/**
 * Find DB sessions whose JSONL files no longer exist on disk.
 * Pure function: takes DB rows + a set of existing file paths → returns stale session IDs.
 *
 * Used by cleanupStaleSessions() at server startup to clear stale claude_session_id values
 * that would cause resume failures.
 */
export function findStaleSessionIds(
  sessions: DbSessionRecord[],
  existingJsonlPaths: Set<string>,
  homeDir: string,
): string[] {
  return sessions
    .filter((s) => {
      const expectedPath = buildJsonlPath(homeDir, s.cwd, s.claude_session_id);
      return !existingJsonlPaths.has(expectedPath);
    })
    .map((s) => s.id);
}

/**
 * Find JSONL files that have no corresponding DB session.
 * These are "orphan" files — created by CLI directly, or left behind after archive/delete.
 * Returns the orphan session IDs (filenames without .jsonl).
 */
export function findOrphanJsonlIds(
  jsonlSessionIds: string[],
  dbClaudeSessionIds: Set<string>,
): string[] {
  return jsonlSessionIds.filter((id) => !dbClaudeSessionIds.has(id));
}
