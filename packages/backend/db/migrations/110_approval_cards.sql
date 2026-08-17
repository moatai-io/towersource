-- 110: Approval Cards
--
-- DB-canonical handoff from an AI team member or human to one accountable approver.
-- My Work and Session surfaces are projections of this state; they do not own a
-- second approval status. Project remains Agent Workspace / Primary AI teammate
-- identity anchor (1:1).

CREATE TABLE IF NOT EXISTS approval_cards (
  id                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  project_id               TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  submitter_type           TEXT NOT NULL DEFAULT 'user'
                           CHECK (submitter_type IN ('user', 'workspace_agent')),
  submitter_user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approver_user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_session_id        TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  source_agent_run_id      TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  source_automation_run_id TEXT REFERENCES automation_runs(id) ON DELETE SET NULL,

  request_type             TEXT NOT NULL DEFAULT 'artifact_review'
                           CHECK (request_type IN ('artifact_review', 'decision', 'action_authorization', 'publication', 'policy_change', 'access_change')),
  title                    TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'approved', 'changes_requested', 'rejected', 'cancelled', 'stale')),
  current_revision_no      INTEGER NOT NULL DEFAULT 1 CHECK (current_revision_no > 0),
  resolved_by_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at              TIMESTAMPTZ,
  due_at                   TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS approval_card_revisions (
  id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  card_id            TEXT NOT NULL REFERENCES approval_cards(id) ON DELETE CASCADE,
  revision_no        INTEGER NOT NULL CHECK (revision_no > 0),
  summary_md         TEXT NOT NULL,
  recommendation_md TEXT,
  consequence_md    TEXT NOT NULL,
  options            JSONB NOT NULL DEFAULT '[]'::jsonb,
  submitted_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(card_id, revision_no)
);

CREATE TABLE IF NOT EXISTS approval_card_attachments (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  card_id        TEXT NOT NULL REFERENCES approval_cards(id) ON DELETE CASCADE,
  revision_no    INTEGER NOT NULL CHECK (revision_no > 0),
  attachment_type TEXT NOT NULL CHECK (attachment_type IN ('markdown', 'file', 'link', 'session', 'run')),
  label          TEXT,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_hash   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (card_id, revision_no)
    REFERENCES approval_card_revisions(card_id, revision_no) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS approval_card_events (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  card_id       TEXT NOT NULL REFERENCES approval_cards(id) ON DELETE CASCADE,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type    TEXT NOT NULL CHECK (event_type IN ('submitted', 'viewed', 'approved', 'changes_requested', 'rejected', 'cancelled', 'resubmitted', 'stale_detected')),
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approval_cards_approver_status_updated
  ON approval_cards(approver_user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_cards_submitter_updated
  ON approval_cards(submitter_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_cards_project_updated
  ON approval_cards(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_cards_source_session
  ON approval_cards(source_session_id) WHERE source_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_approval_cards_source_automation_run
  ON approval_cards(source_automation_run_id) WHERE source_automation_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_approval_card_events_card_created
  ON approval_card_events(card_id, created_at ASC);

CREATE OR REPLACE FUNCTION approval_cards_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_approval_cards_touch ON approval_cards;
CREATE TRIGGER trg_approval_cards_touch
  BEFORE UPDATE ON approval_cards
  FOR EACH ROW EXECUTE FUNCTION approval_cards_touch_updated_at();
