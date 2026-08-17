-- ============================================================
-- 030: session_file_edits — per-session file-edit log
-- ============================================================
--
-- Background: 2026-04-22 decision (workspace/decisions/2026-04-21-session-backlinks-level1.md)
--
-- Level 1 session backlinks was Claude-only because file-edit events live in
-- ~/.claude/memory.db (SQLite), written by the Claude Code memory hooks at
-- ~/.claude/hooks/memory/post-tool-use.mjs. The Pi coding agent harness has
-- no such hooks, so Pi sessions had zero backlink data — "관련 세션 없음" for
-- every Pi session, regardless of how many files they touched.
--
-- This table captures the same (session_id, file_path) signal for any engine
-- the backend routes through pi-engine / future harnesses. Keyed by Tower's
-- own sessions.id (a proper UUID) rather than the overloaded claude_session_id
-- column (which for Pi sessions stores a .pi/sessions/*.jsonl path — separate
-- schema-debt cleanup, out of scope here).
--
-- Query pattern: session-backlinks.ts UNIONs rows from here with file_edit
-- rows from memory.db. IDF is computed over the merged candidate set so hot
-- files remain down-weighted across engines.
--
-- Why not write to memory.db from Tower backend:
--   - memory.db is a Claude Code-owned resource; Tower reads it, doesn't own
--     the schema.
--   - Project direction (MEMORY.md) is SQLite → PostgreSQL for Tower-owned
--     data. Writing MORE data to SQLite would run against that.
--   - When memory.db itself eventually migrates to PG, the UNION collapses.

CREATE TABLE IF NOT EXISTS session_file_edits (
  id         BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  file_path  TEXT NOT NULL,
  tool_name  TEXT NOT NULL,                 -- 'Edit' | 'Write' | 'unknown' (backfill)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backlinks query walks "files for this session" (session_id lookup) and
-- "sessions touching this file" (file_path lookup). Separate indexes over
-- each are far cheaper than a composite for these access patterns.
CREATE INDEX IF NOT EXISTS idx_sfe_session ON session_file_edits(session_id);
CREATE INDEX IF NOT EXISTS idx_sfe_file    ON session_file_edits(file_path);
