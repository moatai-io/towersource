-- ============================================================
-- 029: PostgreSQL FTS (tsvector) — ranking + highlighting
-- ============================================================
--
-- Background: 2026-04-21 decision (workspace/decisions/2026-04-21-search-tsvector-migration.md)
--
-- Previous state (migration 011): pg_trgm GIN on sessions(name, summary) and
-- messages(content). Substring match via ILIKE + pg_trgm works, but has no
-- relevance ranking and no automatic snippet highlighting.
--
-- This migration adds expression-based GIN indexes over to_tsvector('simple', ...)
-- so search.ts can use websearch_to_tsquery for boolean ops ("phrase", AND, OR,
-- -exclusion), ts_rank_cd for relevance ordering, and ts_headline for
-- automatic snippet generation with match highlighting.
--
-- Why 'simple' config:
--   - PG ships no Korean text-search config. 'simple' tokenizes by whitespace /
--     punctuation and lowercases, which works for Korean 어절-level matching.
--   - English stemming is sacrificed ('결제' and '결제를' remain distinct tokens)
--     but the existing pg_trgm indexes (011) are retained as a substring fallback
--     for short / unusual queries — see services/search.ts for the hybrid logic.
--   - Upgrade path: pgroonga (Mecab-ko) if query logs later show real demand.
--
-- Why expression indexes (not generated columns):
--   - ALTER TABLE … ADD COLUMN GENERATED rewrites the whole table. On the
--     demo-org-scale messages table (~180k rows) that's a brief but real
--     lock. Expression indexes build via a single index-only pass — still
--     not CONCURRENTLY-able here (migrations run in a txn) but ~3-5× faster
--     and no column addition.
--   - Query must use the IDENTICAL expression to hit the index.
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_sessions_search_tsv;
--   DROP INDEX IF EXISTS idx_messages_search_tsv;
--   (pg_trgm indexes stay; search.ts auto-falls-back via legacy path.)

BEGIN;

-- Sessions — combined name + summary tsvector
CREATE INDEX IF NOT EXISTS idx_sessions_search_tsv
  ON sessions USING GIN (
    to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(summary, ''))
  );

-- Messages — full content tsvector. JSON keys (type, text, tool_use_id) become
-- high-frequency noise tokens; ts_rank_cd naturally deprioritizes them since
-- they appear in ~every row. We do NOT preprocess content further — keeping
-- the expression IMMUTABLE is required for GIN.
--
-- Truncation: to_tsvector has a 1 MB hard limit per row. Roughly 0.005% of
-- messages (tool_result dumps, pasted logs) exceed this. LEFT(content, 300000)
-- caps at ~900 KB even for 3-byte Korean UTF-8 and still preserves plenty of
-- text for relevance. Matches beyond char 300k in a huge dump fall back to
-- the pg_trgm substring index (011) via search.ts.
CREATE INDEX IF NOT EXISTS idx_messages_search_tsv
  ON messages USING GIN (
    to_tsvector('simple', LEFT(coalesce(content, ''), 300000))
  );

COMMIT;
