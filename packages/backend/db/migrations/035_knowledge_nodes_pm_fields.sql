-- Phase 2-c: PM tracking fields on knowledge_nodes
--
-- See decisions:
--   workspace/decisions/2026-04-25-ai-native-pm-d6-pm-needs-and-non-needs.md
--
-- Adds the minimum field set a non-developer PM needs on top of the
-- knowledge_nodes table:
--   due_date          — when this needs to land (NULL = no deadline)
--   assignee_user_id  — owner (single — watcher lists deliberately not added)
--   updates           — structured event log (status/assignee/due changes + notes)
--
-- The "north star" for this project: PM 입력 필드는 매주 줄어들도록 한다.
-- AI fills in everything it can; humans add at most status / owner / due / note.
-- This migration is the FULL set we expect to live with — no further
-- column additions planned for v1.
--
-- updates shape (every event):
--   { "type": "status_change" | "assignee_change" | "due_change" | "note",
--     "by":   "<user_id>",
--     "at":   "<ISO8601>",
--     "payload": { ... type-specific ... } }
--
-- Rollback:
--   ALTER TABLE knowledge_nodes
--     DROP COLUMN IF EXISTS due_date,
--     DROP COLUMN IF EXISTS assignee_user_id,
--     DROP COLUMN IF EXISTS updates;
--   DROP INDEX IF EXISTS idx_knowledge_nodes_due;
--   DROP INDEX IF EXISTS idx_knowledge_nodes_assignee;

ALTER TABLE knowledge_nodes
  ADD COLUMN IF NOT EXISTS due_date         DATE,
  ADD COLUMN IF NOT EXISTS assignee_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updates          JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Hot path: "what's due soon and still active?" — board's overdue indicator
-- and any future "this week" filter both hit this.
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_due
  ON knowledge_nodes (due_date)
  WHERE status IN ('open', 'in_progress');

-- Hot path: "what does this user own that's still active?" — global "my issues"
-- view. Partial keeps it small (excludes done/archived).
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_assignee
  ON knowledge_nodes (assignee_user_id)
  WHERE status IN ('open', 'in_progress');
