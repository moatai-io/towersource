-- ============================================================
-- 055: messages.metadata + sessions.last_auto_resume_at
--
-- Background:
--   serverSideResumeInterrupted() (ws-handler.ts:1799) injects a synthetic
--   user message after server restart to trigger SDK resume. The message
--   leaks into the chat UI as if the user typed it. We need a way to:
--     1) hide the trigger message from UI while keeping it in DB (audit)
--     2) show a small banner ("auto-resumed at HH:MM") instead
--
-- Decision: workspace/decisions/2026-05-10-server-resume-prompt-hidden.md
-- ============================================================

-- 1) messages.metadata — JSONB blob for hidden flags, debug info, system markers.
--    DEFAULT '{}' NOT NULL so existing rows + reads need no special handling.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb NOT NULL;

-- Optional: GIN index for future queries by hidden flag etc.
-- (skipped for now — small payloads, low query frequency. Add if needed.)

-- 2) sessions.last_auto_resume_at — timestamp of most recent auto-resume.
--    Frontend reads this to show a transient banner ("재시작 후 자동 재개됨").
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS last_auto_resume_at TIMESTAMPTZ;
