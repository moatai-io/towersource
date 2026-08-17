-- 140: Per-user pinned and recently opened Personal Space documents.
CREATE TABLE IF NOT EXISTS personal_document_preferences (
  owner_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  personal_file_id UUID NOT NULL REFERENCES personal_files(id) ON DELETE CASCADE,
  pinned_at      TIMESTAMPTZ,
  last_opened_at TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_user_id, personal_file_id)
);

CREATE INDEX IF NOT EXISTS idx_personal_document_preferences_recent
  ON personal_document_preferences(owner_user_id, last_opened_at DESC)
  WHERE last_opened_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_personal_document_preferences_pinned
  ON personal_document_preferences(owner_user_id, pinned_at DESC)
  WHERE pinned_at IS NOT NULL;
