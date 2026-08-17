-- ============================================================
-- 053: sessions.config_dir — pin the Claude CLAUDE_CONFIG_DIR per-session
--
-- Why
-- ----
-- The SDK writes turn-by-turn .jsonl at:
--     <CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<sessionId>.jsonl
-- The configDir is currently derived per-call as
--     project_id → projects.claude_account_id → claude_accounts.config_dir
-- which has two systemic problems:
--   1. Many call sites silently skip this lookup (cloneSession until 2026-05-09,
--      channelReply, spawnTask, audit/zombie scans). On those paths we drop to
--      default ~/.claude/ even when the project is bound to a non-default
--      account → jsonl created under the wrong dir, resume fails on next turn.
--   2. When `projects.claude_account_id` is later reassigned, *existing*
--      session jsonl files don't move — they stay in the configDir where they
--      were originally written. The current per-call lookup returns the *new*
--      account's configDir, mismatching reality. claude-sdk.ts:468-487 covers
--      this with a "find-and-copy" hack which becomes unnecessary once each
--      session pins its own configDir.
--
-- Design
-- ------
-- Add `config_dir` as nullable text. New sessions populate it at create time
-- from getConfigDir(project_id). Backfill existing rows in this migration via
-- the same lookup. NULL stays a valid sentinel meaning "fall back to runtime
-- getConfigDir lookup" — keeps the migration reversible and lets the column
-- be adopted by callers gradually.
--
-- Audit (2026-05-09): workspace/decisions/2026-05-09-multi-account-configdir-audit.md
-- ============================================================

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS config_dir TEXT;

-- Backfill: resolve via the same chain getConfigDir() uses at runtime.
-- For sessions whose project has an enabled account assignment, copy that
-- account's config_dir. Sessions without project_id, or whose project lacks
-- an enabled account, keep config_dir = NULL (callers fall back to the
-- default-account lookup at runtime).
UPDATE sessions s
   SET config_dir = ca.config_dir
  FROM projects p
  JOIN claude_accounts ca ON ca.id = p.claude_account_id AND ca.enabled = true
 WHERE s.project_id = p.id
   AND s.config_dir IS NULL;

-- Index intentionally omitted — config_dir is read on the session-by-session
-- path (after we already fetched the row by id), not used as a filter.
