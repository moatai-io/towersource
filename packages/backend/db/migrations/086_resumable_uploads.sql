-- ============================================================
-- 086: Resumable project uploads
-- ============================================================
-- Stores metadata for chunked, resumable project uploads. File bytes live in
-- project-local staging directories under workspace/projects/<p>/uploads/.staging/.
-- Decision: workspace/decisions/2026-06-08-large-folder-resumable-upload.md
-- Issue: internal issue #79

CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_dir TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'created',
    'uploading',
    'completing',
    'completed',
    'cancelled',
    'expired',
    'failed'
  )),
  chunk_size INTEGER NOT NULL,
  total_bytes BIGINT NOT NULL,
  uploaded_bytes BIGINT NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS upload_session_files (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  size BIGINT NOT NULL,
  last_modified BIGINT,
  sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'pending',
    'uploading',
    'uploaded',
    'completed',
    'failed'
  )),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, relative_path)
);

CREATE TABLE IF NOT EXISTS upload_chunks (
  session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES upload_session_files(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, file_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS upload_sessions_project_status_idx
  ON upload_sessions(project_id, status);

CREATE INDEX IF NOT EXISTS upload_sessions_expires_at_idx
  ON upload_sessions(expires_at)
  WHERE status IN ('created', 'uploading', 'failed');

CREATE INDEX IF NOT EXISTS upload_session_files_session_idx
  ON upload_session_files(session_id);
