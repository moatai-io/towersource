-- Knowledge Graph for AI-native PM (alpha)
--
-- See decisions:
--   workspace/decisions/2026-04-24-ai-native-pm-plan.md
--   workspace/decisions/2026-04-24-ai-native-pm-d3-table-separation.md
--   workspace/decisions/2026-04-24-ai-native-pm-d5-dedup-strategy.md
--
-- Purpose: store AI-extracted issues/decisions/assumptions (nodes), their
-- relationships (edges), and the pending proposals awaiting human triage
-- (candidates). This is NOT a replacement for the existing `tasks` table
-- which tracks AI-executed agent runs — different lifecycle, different
-- owner, different failure model (D3).
--
-- Deployment scope (alpha):
--   - Full organization control-plane profile only. Managed and standalone
--     self-host deployments MUST NOT receive this feature yet. The migration
--     itself is harmless (empty tables), but the distiller + UI are
--     gated by AI_PM_ENABLED env var.
--
-- Dedup contract (D5, enforced at app layer using these columns):
--   Layer 1 — session gate:  candidates.source_session already distilled? skip.
--   Layer 2 — source range:  candidates.source_range overlaps existing? skip.
--   Layer 3 — reject memory: source_hash exists with review_status='rejected'? skip.
--
-- Cross-project visibility (D2) is UNRESOLVED. The `projects` column is
-- text[] for forward compatibility, but this migration enforces length=1
-- via CHECK so we don't ship a half-baked visibility model. When D2
-- lands, drop the CHECK and layer visibility enforcement at the API.
--
-- Rollback:
--   DROP TABLE IF EXISTS knowledge_candidates CASCADE;
--   DROP TABLE IF EXISTS knowledge_edges      CASCADE;
--   DROP TABLE IF EXISTS knowledge_nodes      CASCADE;
--   (no data loss risk for any other table; FKs are self-contained)

-- ============================================================
-- knowledge_nodes
-- ============================================================
-- The canonical store. A row exists here only after a human has
-- accepted a candidate (or explicitly created one). AI never writes
-- directly to this table after a user has interacted with the row.

CREATE TABLE IF NOT EXISTS knowledge_nodes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Type of node. Extending this enum list requires careful thought
  -- about lifecycle / UI / status vocabulary — not a free addition.
  kind         TEXT NOT NULL
               CHECK (kind IN ('issue', 'decision', 'assumption')),

  title        TEXT NOT NULL,

  -- Freeform structured body. Shape is kind-specific and evolves:
  --   issue      → { description, labels, priority, ... }
  --   decision   → { context, options, rationale, ... }
  --   assumption → { statement, evidence_refs, ... }
  -- Intentionally not split into per-kind tables — too early to commit
  -- to a fixed shape. Revisit if query patterns demand columns.
  content      JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Status vocabulary varies per kind. CHECK enforces the valid set.
  --   issue:      open, in_progress, done, archived
  --   decision:   active, superseded, deprecated
  --   assumption: active, invalidated, stale
  status       TEXT NOT NULL,
  CONSTRAINT knowledge_nodes_status_valid CHECK (
    (kind = 'issue'      AND status IN ('open', 'in_progress', 'done', 'archived'))
    OR
    (kind = 'decision'   AND status IN ('active', 'superseded', 'deprecated'))
    OR
    (kind = 'assumption' AND status IN ('active', 'invalidated', 'stale'))
  ),

  -- Project tags. D2 is unresolved, so enforce single-project until
  -- union/intersect/owner visibility is decided. Dropping this CHECK
  -- when D2 lands is one-line; the reverse is a data migration.
  projects     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  CONSTRAINT knowledge_nodes_single_project_alpha
    CHECK (array_length(projects, 1) IS NULL OR array_length(projects, 1) = 1),

  -- Where did this come from? Mandatory trail for every node.
  --   { source_session, message_id_range: {first, last}, source_hash, candidate_id? }
  -- Null only permitted for user-created-from-scratch nodes (rare in alpha).
  provenance   JSONB,

  -- Distiller's self-reported confidence at extraction time.
  -- Recorded for calibration analysis; NOT used to gate UI in alpha
  -- (we want to see what low-confidence extractions look like).
  confidence   REAL,

  -- 'ai' for distiller-originated, or a user_id string for manual.
  created_by   TEXT NOT NULL DEFAULT 'ai',

  -- The user who promoted a candidate into this row. Null iff created_by != 'ai'
  -- (i.e., manual creation doesn't need a separate accepter).
  accepted_by  TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Triage/board views: filter by kind + status ordered by recency.
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_kind_status
  ON knowledge_nodes (kind, status, created_at DESC);

-- Project filter. GIN on text[] supports `projects @> ARRAY['x']` cheaply.
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_projects
  ON knowledge_nodes USING GIN (projects);

-- Content search. tsvector built over title + content->>'description' etc.
-- Kept simple for alpha — revisit after distiller output stabilizes.
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_title_trgm
  ON knowledge_nodes USING GIN (title gin_trgm_ops);

-- Maintain updated_at without relying on ORMs remembering to set it.
CREATE OR REPLACE FUNCTION knowledge_nodes_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_knowledge_nodes_touch ON knowledge_nodes;
CREATE TRIGGER trg_knowledge_nodes_touch
  BEFORE UPDATE ON knowledge_nodes
  FOR EACH ROW EXECUTE FUNCTION knowledge_nodes_touch_updated_at();


-- ============================================================
-- knowledge_edges
-- ============================================================
-- Typed relationships between nodes. Edges are themselves first-class
-- (have IDs) so they can carry evidence and be audited/retracted.

CREATE TABLE IF NOT EXISTS knowledge_edges (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  from_id     UUID NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  to_id       UUID NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,

  -- Relationship types. Semantics are intentionally specific:
  --   supersedes     — decision A replaces decision B (A.from → B.to)
  --   blocks         — issue A cannot complete until B is resolved
  --   resolved_by    — issue A was resolved by decision/commit B
  --   discussed_in   — node A was debated in session/message B (B is a pseudo-node? TBD)
  --   assumes        — decision A rests on assumption B
  --   invalidates    — fact change / new decision makes B no longer valid
  --   clusters_with  — AI-detected near-duplicate; merge candidate
  --   relates_to     — weaker catch-all; avoid if a more specific rel fits
  rel         TEXT NOT NULL
              CHECK (rel IN (
                'supersedes', 'blocks', 'resolved_by', 'discussed_in',
                'assumes', 'invalidates', 'clusters_with', 'relates_to'
              )),

  -- Why does the AI/user think this edge exists?
  --   { source_session, message_id_range, rationale_snippet, detector_version }
  evidence    JSONB,

  confidence  REAL,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Prevent exact duplicate edges of the same type between the same pair.
  -- Allows multiple edges with different rel (A supersedes B AND A relates_to B).
  CONSTRAINT knowledge_edges_unique_triple UNIQUE (from_id, to_id, rel),

  -- No self-loops. A node cannot supersede itself.
  CONSTRAINT knowledge_edges_no_self_loop CHECK (from_id <> to_id)
);

-- Forward traversal: "what does this node affect?"
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_from
  ON knowledge_edges (from_id, rel);

-- Backward traversal: "what superseded this? what blocks this?"
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_to
  ON knowledge_edges (to_id, rel);


-- ============================================================
-- knowledge_candidates
-- ============================================================
-- Inbox of AI proposals. A row lives here until a human accepts,
-- rejects, merges, or it ages out (→ stale). Rejected rows are
-- KEPT (not deleted) so D5 Layer 3 can prevent re-proposal by hash.

CREATE TABLE IF NOT EXISTS knowledge_candidates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  kind            TEXT NOT NULL
                  CHECK (kind IN ('issue', 'decision', 'assumption')),

  -- Proposed node content. Shape matches knowledge_nodes.content schema
  -- for the same kind — on accept, this is copied over.
  draft           JSONB NOT NULL,

  -- D5 Layer 1: one distillation run per (session, kind). The session_id
  -- references sessions.id but we don't FK — sessions may be archived
  -- without wanting to cascade-delete triage history.
  source_session  TEXT NOT NULL,

  -- D5 Layer 2: which messages in the source session generated this
  -- candidate? Shape: { first_message_id, last_message_id }. Used to
  -- detect overlap with existing candidates from the same session.
  source_range    JSONB NOT NULL,

  -- D5 Layer 3: SHA-256 of normalized draft content (lowercased,
  -- whitespace-collapsed, markdown-stripped, dates/paths placeholdered).
  -- Normalization function lives in the distiller service, NOT here —
  -- the DB just stores and indexes whatever the service hands it.
  source_hash     TEXT NOT NULL,

  confidence      REAL,

  review_status   TEXT NOT NULL DEFAULT 'pending'
                  CHECK (review_status IN (
                    'pending', 'accepted', 'rejected', 'merged', 'stale'
                  )),

  -- Set when review_status transitions away from 'pending'.
  reviewed_by     TEXT,
  review_reason   TEXT,
  merged_into     UUID REFERENCES knowledge_nodes(id) ON DELETE SET NULL,
  promoted_to     UUID REFERENCES knowledge_nodes(id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at     TIMESTAMPTZ
);

-- One candidate per (session, kind, range-start) is the enforcement
-- for Layer 1+2. Not a full overlap check — that's the app's job —
-- but catches the dumb "same session distilled twice" case cheaply.
-- Must be a UNIQUE INDEX (not table constraint) because jsonb
-- expressions aren't allowed in UNIQUE constraint column lists.
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_candidates_session_range_unique
  ON knowledge_candidates (
    source_session,
    kind,
    (source_range->>'first_message_id')
  );

-- Triage queue: "show me pending candidates, newest first"
CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_pending
  ON knowledge_candidates (created_at DESC)
  WHERE review_status = 'pending';

-- D5 Layer 3 hot path: "is this hash already rejected?"
-- Partial index keeps it small (only rejected rows are of interest).
CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_rejected_hash
  ON knowledge_candidates (source_hash)
  WHERE review_status = 'rejected';

-- D5 Layer 1 hot path: "has this session been distilled for this kind?"
CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_session_kind
  ON knowledge_candidates (source_session, kind);


-- ============================================================
-- Done. Feature is DB-ready but code-dark until AI_PM_ENABLED=true.
-- ============================================================
