-- 157: Turn-scoped file checkpoints and append-only restore audit.

CREATE TABLE IF NOT EXISTS turn_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  root_turn_id TEXT NOT NULL REFERENCES agent_turns(root_turn_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  coverage TEXT NOT NULL DEFAULT 'tool_edits' CHECK (coverage IN ('tool_edits', 'partial')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (root_turn_id)
);

CREATE TABLE IF NOT EXISTS checkpoint_file_changes (
  id BIGSERIAL PRIMARY KEY,
  checkpoint_id UUID NOT NULL REFERENCES turn_checkpoints(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  before_exists BOOLEAN NOT NULL,
  before_sha256 TEXT,
  before_content BYTEA,
  after_exists BOOLEAN NOT NULL,
  after_sha256 TEXT,
  after_content BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (checkpoint_id, file_path)
);

CREATE TABLE IF NOT EXISTS checkpoint_restore_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkpoint_id UUID NOT NULL REFERENCES turn_checkpoints(id) ON DELETE CASCADE,
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  mode TEXT NOT NULL DEFAULT 'files_only' CHECK (mode = 'files_only'),
  status TEXT NOT NULL CHECK (status IN ('previewed', 'applied', 'conflict', 'failed')),
  preview_hash TEXT NOT NULL,
  selected_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
  conflicts JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_checkpoint_file_changes_checkpoint
  ON checkpoint_file_changes(checkpoint_id, file_path);
CREATE INDEX IF NOT EXISTS idx_checkpoint_restore_runs_checkpoint
  ON checkpoint_restore_runs(checkpoint_id, created_at DESC);
