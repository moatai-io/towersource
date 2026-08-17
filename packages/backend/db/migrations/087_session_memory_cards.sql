-- Session continuity cards — Pi startup personal memory source
--
-- One card per Tower session. The card is refreshed in-place as the session
-- progresses and later composed into <memory-context> for new Pi sessions.
--
-- Decision: workspace/decisions/2026-06-09-session-continuity-cards.md
-- Rollback:
--   DROP TABLE IF EXISTS session_memory_cards;

CREATE TABLE IF NOT EXISTS session_memory_cards (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  project_id TEXT REFERENCES projects(id),

  card_version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,

  title TEXT,
  outcome TEXT,
  pain_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  resolved JSONB NOT NULL DEFAULT '[]'::jsonb,
  steps_taken JSONB NOT NULL DEFAULT '[]'::jsonb,
  next_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  artifacts JSONB NOT NULL DEFAULT '[]'::jsonb,
  decisions JSONB NOT NULL DEFAULT '[]'::jsonb,
  cautions JSONB NOT NULL DEFAULT '[]'::jsonb,
  touched_files JSONB NOT NULL DEFAULT '[]'::jsonb,

  covered_turn_count INTEGER NOT NULL DEFAULT 0,
  covered_message_id TEXT,
  covered_message_created_at TIMESTAMPTZ,

  model TEXT,
  confidence TEXT,
  generation_status TEXT NOT NULL DEFAULT 'success',
  last_error TEXT,

  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_memory_cards_user_project_updated
  ON session_memory_cards(user_id, project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_memory_cards_project_updated
  ON session_memory_cards(project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_memory_cards_next_actions
  ON session_memory_cards USING gin(next_actions);

CREATE INDEX IF NOT EXISTS idx_session_memory_cards_artifacts
  ON session_memory_cards USING gin(artifacts);

CREATE INDEX IF NOT EXISTS idx_session_memory_cards_search_tsv
  ON session_memory_cards USING gin(to_tsvector('simple',
    COALESCE(title, '') || ' ' ||
    COALESCE(outcome, '') || ' ' ||
    pain_points::text || ' ' ||
    resolved::text || ' ' ||
    steps_taken::text || ' ' ||
    next_actions::text || ' ' ||
    artifacts::text || ' ' ||
    decisions::text || ' ' ||
    cautions::text || ' ' ||
    touched_files::text
  ));
