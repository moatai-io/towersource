-- Session label for grouping within a project
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS label TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_label ON sessions(label) WHERE label IS NOT NULL;
