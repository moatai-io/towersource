-- 129: Persist immutable Prompt Bundle identity alongside Session Harness snapshots.

ALTER TABLE session_runtime_snapshots
  ADD COLUMN IF NOT EXISTS prompt_bundle_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_session_runtime_snapshots_prompt_bundle
  ON session_runtime_snapshots(prompt_bundle_hash,pinned_at DESC)
  WHERE prompt_bundle_hash IS NOT NULL;

-- Existing snapshots predate Prompt Component Registry v2. Runtime derives their
-- compatibility bundle hash from the immutable snapshot JSON and does not rewrite
-- historical snapshots in place.
