import { describe, it, expect } from 'vitest';
import {
  shouldDropSessionMessage,
  shouldResetAssistantRef,
  shouldAutoSendQueue,
  resolveAutoNameTarget,
  resolveSendSessionId,
  dedupeSessionsById,
  addSessionIfNew,
  resolveResumeSessionId,
  isServerRestarted,
  encodeCwdForClaudePath,
  buildJsonlPath,
  findStaleSessionIds,
  findOrphanJsonlIds,
  type AutoNameContext,
  type SessionLike,
  type DbSessionRecord,
} from './session-filters';

// ── shouldDropSessionMessage ───────────────────────────────────────

describe('shouldDropSessionMessage', () => {
  it('returns false when currentSessionId is null (first connection)', () => {
    expect(shouldDropSessionMessage(null, 'any-session')).toBe(false);
  });

  it('returns false when sessions match', () => {
    expect(shouldDropSessionMessage('s1', 's1')).toBe(false);
  });

  it('returns true when sessions differ (drop message)', () => {
    expect(shouldDropSessionMessage('s1', 's2')).toBe(true);
  });

  it('uses the visible session while chatStore is null during a session switch', () => {
    expect(shouldDropSessionMessage(null, 'background-session', 'visible-session')).toBe(true);
    expect(shouldDropSessionMessage(null, 'visible-session', 'visible-session')).toBe(false);
  });

  it('uses the visible session when chatStore still points at the previous transcript', () => {
    expect(shouldDropSessionMessage('previous-session', 'previous-session', 'visible-session')).toBe(true);
    expect(shouldDropSessionMessage('previous-session', 'visible-session', 'visible-session')).toBe(false);
  });

  it('uses the visible session as authoritative while chatStore is temporarily null', () => {
    expect(shouldDropSessionMessage(null, 'background-s2', 'visible-s1')).toBe(true);
    expect(shouldDropSessionMessage(null, 'visible-s1', 'visible-s1')).toBe(false);
  });

  it('uses the visible session as authoritative when chatStore is stale', () => {
    expect(shouldDropSessionMessage('old-s0', 'visible-s1', 'visible-s1')).toBe(false);
    expect(shouldDropSessionMessage('old-s0', 'old-s0', 'visible-s1')).toBe(true);
  });

  it('returns false when both currentSessionId is null and incomingSessionId is undefined', () => {
    expect(shouldDropSessionMessage(null, undefined)).toBe(false);
  });

  it('returns true when currentSessionId has value but incomingSessionId is undefined', () => {
    expect(shouldDropSessionMessage('s1', undefined)).toBe(true);
  });

  it('returns false when currentSessionId is empty string (falsy, treated as no session)', () => {
    expect(shouldDropSessionMessage('' as any, 'any')).toBe(false);
  });
});

// ── shouldResetAssistantRef ────────────────────────────────────────

describe('shouldResetAssistantRef', () => {
  it('returns true when session changed from ref', () => {
    expect(shouldResetAssistantRef('s1', 's2')).toBe(true);
  });

  it('returns false when session matches ref', () => {
    expect(shouldResetAssistantRef('s1', 's1')).toBe(false);
  });

  it('returns false when ref is null (no prior session)', () => {
    expect(shouldResetAssistantRef(null, 's1')).toBe(false);
  });
});

// ── shouldAutoSendQueue ────────────────────────────────────────────

describe('shouldAutoSendQueue', () => {
  it('returns false when still streaming', () => {
    expect(shouldAutoSendQueue(true, 's1', 's1')).toBe(false);
  });

  it('returns true when not streaming and sessions match', () => {
    expect(shouldAutoSendQueue(false, 's1', 's1')).toBe(true);
  });

  it('returns false when not streaming but sessions differ (drop queued)', () => {
    expect(shouldAutoSendQueue(false, 's1', 's2')).toBe(false);
  });

  it('returns false when currentSessionId is null', () => {
    expect(shouldAutoSendQueue(false, 's1', null)).toBe(false);
  });
});

// ── resolveAutoNameTarget ──────────────────────────────────────────
// Regression tests for the bug where auto-name used activeSessionId
// (an orphan session with 0 messages) instead of doneSessionId
// (the session where messages actually live).

describe('resolveAutoNameTarget', () => {
  const base: AutoNameContext = {
    doneSessionId: 'done-123',
    activeSessionId: 'active-456',
    sessionName: 'Session 3/10/2026, 12:18:37 PM',
    hasUserMsg: true,
    hasAssistantMsg: true,
  };

  it('prefers doneSessionId over activeSessionId', () => {
    // THE FIX: messages live under doneSessionId, not activeSessionId
    expect(resolveAutoNameTarget(base)).toBe('done-123');
  });

  it('falls back to activeSessionId when doneSessionId is undefined', () => {
    expect(resolveAutoNameTarget({
      ...base,
      doneSessionId: undefined,
    })).toBe('active-456');
  });

  it('returns null when both IDs are missing', () => {
    expect(resolveAutoNameTarget({
      ...base,
      doneSessionId: undefined,
      activeSessionId: null,
    })).toBeNull();
  });

  it('returns null when session name does not start with "Session "', () => {
    expect(resolveAutoNameTarget({
      ...base,
      sessionName: 'My Custom Title',
    })).toBeNull();
  });

  it('returns null when session name is undefined (session not found)', () => {
    expect(resolveAutoNameTarget({
      ...base,
      sessionName: undefined,
    })).toBeNull();
  });

  it('returns null when no user message exists', () => {
    expect(resolveAutoNameTarget({
      ...base,
      hasUserMsg: false,
    })).toBeNull();
  });

  it('returns null when no assistant message exists', () => {
    expect(resolveAutoNameTarget({
      ...base,
      hasAssistantMsg: false,
    })).toBeNull();
  });

  it('returns null when neither user nor assistant messages exist', () => {
    expect(resolveAutoNameTarget({
      ...base,
      hasUserMsg: false,
      hasAssistantMsg: false,
    })).toBeNull();
  });

  it('works when both IDs are the same', () => {
    expect(resolveAutoNameTarget({
      ...base,
      doneSessionId: 'same-id',
      activeSessionId: 'same-id',
    })).toBe('same-id');
  });

  it('triggers for name starting with "Session " even if minimal', () => {
    expect(resolveAutoNameTarget({
      ...base,
      sessionName: 'Session ',
    })).toBe('done-123');
  });
});

// ── resolveSendSessionId ───────────────────────────────────────────

describe('resolveSendSessionId', () => {
  it('uses chatStore sessionId when it matches the visible active session', () => {
    const result = resolveSendSessionId('same-s1', 'same-s1');
    expect(result).toEqual({ sessionId: 'same-s1', source: 'chatStore' });
  });

  it('falls back to sessionStore when chatStore is null', () => {
    const result = resolveSendSessionId(null, 'store-s2');
    expect(result).toEqual({ sessionId: 'store-s2', source: 'sessionStore' });
  });

  it('returns null when both stores have no session', () => {
    expect(resolveSendSessionId(null, null)).toBeNull();
  });

  it('prefers the visible active session when stores disagree', () => {
    const result = resolveSendSessionId('chat-s1', 'store-s2');
    expect(result).toEqual({ sessionId: 'store-s2', source: 'sessionStore' });
  });

  it('recovers from desync via sessionStore fallback', () => {
    const result = resolveSendSessionId(null, 'correct-session');
    expect(result?.sessionId).toBe('correct-session');
    expect(result?.source).toBe('sessionStore');
  });
});

// ── dedupeSessionsById ─────────────────────────────────────────────
// Tests for session deduplication — prevents duplicate entries in sidebar.
// Past issue: rapid session creation caused same session to appear twice.

describe('dedupeSessionsById', () => {
  it('removes duplicate IDs, keeping the first occurrence', () => {
    const sessions: SessionLike[] = [
      { id: 's1', name: 'First' },
      { id: 's1', name: 'Duplicate' },
      { id: 's2', name: 'Unique' },
    ];
    const result = dedupeSessionsById(sessions);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('First');
    expect(result[1].name).toBe('Unique');
  });

  it('returns all sessions when no duplicates', () => {
    const sessions: SessionLike[] = [
      { id: 's1', name: 'A' },
      { id: 's2', name: 'B' },
      { id: 's3', name: 'C' },
    ];
    expect(dedupeSessionsById(sessions)).toHaveLength(3);
  });

  it('handles empty array', () => {
    expect(dedupeSessionsById([])).toHaveLength(0);
  });

  it('allows different IDs with same name (not a duplicate)', () => {
    const sessions: SessionLike[] = [
      { id: 's1', name: 'Session 3/10/2026' },
      { id: 's2', name: 'Session 3/10/2026' },
    ];
    expect(dedupeSessionsById(sessions)).toHaveLength(2);
  });

  it('handles triple duplicates', () => {
    const sessions: SessionLike[] = [
      { id: 's1', name: 'V1' },
      { id: 's1', name: 'V2' },
      { id: 's1', name: 'V3' },
    ];
    const result = dedupeSessionsById(sessions);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('V1');
  });
});

// ── addSessionIfNew ────────────────────────────────────────────────
// Tests for single-session addition with dedup guard.

describe('addSessionIfNew', () => {
  const existing: SessionLike[] = [
    { id: 's1', name: 'Existing' },
    { id: 's2', name: 'Another' },
  ];

  it('prepends new session when ID is unique', () => {
    const result = addSessionIfNew(existing, { id: 's3', name: 'New' });
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('New');
  });

  it('returns same reference when ID already exists (no rerender)', () => {
    const result = addSessionIfNew(existing, { id: 's1', name: 'Duplicate' });
    expect(result).toBe(existing); // Same reference = React skips rerender
  });

  it('works with empty existing list', () => {
    const result = addSessionIfNew([], { id: 's1', name: 'First' });
    expect(result).toHaveLength(1);
  });
});

// ── resolveResumeSessionId ─────────────────────────────────────────
// Tests for SDK session resume after server restart.
// Past issue: server restart lost claudeSessionId, causing
// sessions to start fresh instead of resuming.

describe('resolveResumeSessionId', () => {
  it('uses client-provided ID when available (freshest)', () => {
    expect(resolveResumeSessionId('client-cid', 'db-cid')).toBe('client-cid');
  });

  it('falls back to DB-stored ID when client has none', () => {
    expect(resolveResumeSessionId(undefined, 'db-cid')).toBe('db-cid');
  });

  it('falls back to DB-stored ID when client sends null', () => {
    expect(resolveResumeSessionId(null, 'db-cid')).toBe('db-cid');
  });

  it('returns undefined when neither has a value (new session)', () => {
    expect(resolveResumeSessionId(undefined, undefined)).toBeUndefined();
  });

  it('returns undefined when both are null', () => {
    expect(resolveResumeSessionId(null, null)).toBeUndefined();
  });

  // Server restart scenario: client reconnects without claudeSessionId,
  // but DB still has it from before the restart
  it('server restart: client has no ID, DB retains it', () => {
    const result = resolveResumeSessionId(null, 'pre-restart-cid');
    expect(result).toBe('pre-restart-cid');
  });

  // After cleanupStaleSessions: DB cleared the stale ID
  it('after cleanup: DB also has no ID', () => {
    expect(resolveResumeSessionId(null, null)).toBeUndefined();
  });
});

// ── isServerRestarted ──────────────────────────────────────────────
// Tests for server restart detection via epoch comparison.
// Past issue: streaming indicators stayed active after restart,
// pending messages were never marked as failed.

describe('isServerRestarted', () => {
  it('returns true when epoch changed', () => {
    expect(isServerRestarted('epoch-1', 'epoch-2')).toBe(true);
  });

  it('returns false when epoch is the same (reconnect, not restart)', () => {
    expect(isServerRestarted('epoch-1', 'epoch-1')).toBe(false);
  });

  it('returns false on first connection (no previous epoch)', () => {
    expect(isServerRestarted(null, 'epoch-1')).toBe(false);
  });

  it('returns false when new epoch is null (legacy server)', () => {
    expect(isServerRestarted('epoch-1', null)).toBe(false);
  });

  it('returns false when new epoch is undefined', () => {
    expect(isServerRestarted('epoch-1', undefined)).toBe(false);
  });

  it('returns false when both are null (first connection, no epoch)', () => {
    expect(isServerRestarted(null, null)).toBe(false);
  });
});

// ── encodeCwdForClaudePath ──────────────────────────────────────────
// Tests for CWD → Claude CLI directory encoding.
// This encoding must exactly match what Claude CLI uses internally.

describe('encodeCwdForClaudePath', () => {
  it('replaces all slashes with dashes', () => {
    expect(encodeCwdForClaudePath('/home/user/project')).toBe('-home-user-project');
  });

  it('handles root path', () => {
    expect(encodeCwdForClaudePath('/')).toBe('-');
  });

  it('handles deeply nested path', () => {
    expect(encodeCwdForClaudePath('/a/b/c/d/e')).toBe('-a-b-c-d-e');
  });

  it('handles path without leading slash', () => {
    expect(encodeCwdForClaudePath('relative/path')).toBe('relative-path');
  });
});

// ── buildJsonlPath ──────────────────────────────────────────────────
// Tests for JSONL file path construction.
// Must match: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl

describe('buildJsonlPath', () => {
  it('builds correct path for standard session', () => {
    const result = buildJsonlPath('/home/user', '/home/user/project', 'abc-123');
    expect(result).toBe('/home/user/.claude/projects/-home-user-project/abc-123.jsonl');
  });

  it('uses homeDir for .claude base', () => {
    const result = buildJsonlPath('/root', '/var/app', 'session-1');
    expect(result).toBe('/root/.claude/projects/-var-app/session-1.jsonl');
  });
});

// ── findStaleSessionIds ─────────────────────────────────────────────
// Tests for DB↔JSONL sync validation.
// Past issue: after server restart, stale claude_session_id in DB caused
// resume failures because the .jsonl file was already deleted.

describe('findStaleSessionIds', () => {
  const homeDir = '/home/user';

  const mkSession = (id: string, csid: string, cwd: string): DbSessionRecord => ({
    id, claude_session_id: csid, cwd,
  });

  it('returns empty when all sessions have matching JSONL files', () => {
    const sessions = [
      mkSession('s1', 'csid-1', '/home/user/project'),
      mkSession('s2', 'csid-2', '/home/user/other'),
    ];
    const existing = new Set([
      '/home/user/.claude/projects/-home-user-project/csid-1.jsonl',
      '/home/user/.claude/projects/-home-user-other/csid-2.jsonl',
    ]);
    expect(findStaleSessionIds(sessions, existing, homeDir)).toEqual([]);
  });

  it('detects sessions with missing JSONL files', () => {
    const sessions = [
      mkSession('s1', 'csid-1', '/home/user/project'),
      mkSession('s2', 'csid-2', '/home/user/project'),
    ];
    // Only s1 has a file
    const existing = new Set([
      '/home/user/.claude/projects/-home-user-project/csid-1.jsonl',
    ]);
    expect(findStaleSessionIds(sessions, existing, homeDir)).toEqual(['s2']);
  });

  it('returns all sessions when no JSONL files exist', () => {
    const sessions = [
      mkSession('s1', 'csid-1', '/home/user/project'),
      mkSession('s2', 'csid-2', '/home/user/project'),
    ];
    const existing = new Set<string>();
    const stale = findStaleSessionIds(sessions, existing, homeDir);
    expect(stale).toEqual(['s1', 's2']);
  });

  it('returns empty for empty session list', () => {
    expect(findStaleSessionIds([], new Set(), homeDir)).toEqual([]);
  });

  it('handles sessions with different cwds correctly', () => {
    const sessions = [
      mkSession('s1', 'same-csid', '/home/user/projectA'),
      mkSession('s2', 'same-csid', '/home/user/projectB'),
    ];
    // Same session ID but only projectA has the file
    const existing = new Set([
      '/home/user/.claude/projects/-home-user-projectA/same-csid.jsonl',
    ]);
    expect(findStaleSessionIds(sessions, existing, homeDir)).toEqual(['s2']);
  });
});

// ── findOrphanJsonlIds ──────────────────────────────────────────────
// Tests for detecting JSONL files without DB records.
// These are "ghost" sessions — files left behind by CLI usage, archived
// sessions, or crashed processes.

describe('findOrphanJsonlIds', () => {
  it('returns empty when all JSONL files have DB records', () => {
    const jsonlIds = ['csid-1', 'csid-2'];
    const dbIds = new Set(['csid-1', 'csid-2', 'csid-3']);
    expect(findOrphanJsonlIds(jsonlIds, dbIds)).toEqual([]);
  });

  it('detects JSONL files not in DB', () => {
    const jsonlIds = ['csid-1', 'csid-2', 'csid-3'];
    const dbIds = new Set(['csid-1']);
    expect(findOrphanJsonlIds(jsonlIds, dbIds)).toEqual(['csid-2', 'csid-3']);
  });

  it('returns all when DB is empty', () => {
    const jsonlIds = ['csid-1', 'csid-2'];
    const dbIds = new Set<string>();
    expect(findOrphanJsonlIds(jsonlIds, dbIds)).toEqual(['csid-1', 'csid-2']);
  });

  it('returns empty when no JSONL files exist', () => {
    const dbIds = new Set(['csid-1', 'csid-2']);
    expect(findOrphanJsonlIds([], dbIds)).toEqual([]);
  });

  it('handles the real scenario: 312 JSONL files, 75 in DB', () => {
    // Simulate the actual ratio we found
    const dbIds = new Set(Array.from({ length: 75 }, (_, i) => `db-${i}`));
    const jsonlIds = [
      ...Array.from({ length: 75 }, (_, i) => `db-${i}`),     // 75 matched
      ...Array.from({ length: 237 }, (_, i) => `orphan-${i}`), // 237 orphans
    ];
    const orphans = findOrphanJsonlIds(jsonlIds, dbIds);
    expect(orphans).toHaveLength(237);
    expect(orphans.every((id) => id.startsWith('orphan-'))).toBe(true);
  });
});
