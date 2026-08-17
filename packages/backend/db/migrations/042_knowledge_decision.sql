-- 042_knowledge_decision.sql — D13 #5A: Decisions as first-class graph nodes.
--
-- workspace/decisions/*.md files are the source of truth. This migration
-- doesn't add a new table — kind='decision' lives in knowledge_nodes — but
-- adds an index for source_file lookups (importer needs fast upsert by path).
--
-- Decision-specific fields live in knowledge_nodes.content jsonb:
--   - decision_id_str  ("2026-04-26-ai-native-pm-d12-...")
--   - body_md           (full markdown body)
--   - status            ('proposed' | 'decided' | 'superseded' | 'abandoned')
--   - owner             (string)
--   - parent_id_str     (FK-like reference, resolved to edges)
--   - related_id_strs   (array)
--
-- Edges:
--   knowledge_edges with edge_type='parent_decision', 'related_decision', 'motivates_wg'

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_decision_file
  ON knowledge_nodes ((content->>'decision_id_str'))
  WHERE kind = 'decision';

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_decision_kind
  ON knowledge_nodes (kind, created_at DESC)
  WHERE kind = 'decision';

COMMENT ON INDEX idx_knowledge_nodes_decision_file IS
  'D13 — fast upsert lookup for decision importer (workspace/decisions/*.md).';
