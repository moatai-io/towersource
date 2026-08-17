-- ============================================================
-- 102: Normalize message search documents before tsvector indexing
-- ============================================================
--
-- Background: GitHub issue #140 found that /search could index and surface
-- serialized tool payloads, long URLs, base64-ish blobs, and JSON scaffolding
-- before the human-readable conversation text.
--
-- Keep the public search.ts API narrow, but move message indexing to an
-- IMMUTABLE SQL helper so the GIN expression index and runtime queries use the
-- same normalized document expression.
--
-- The helper intentionally extracts only common human-readable text fields from
-- JSON block arrays. Tool inputs/results are metadata-heavy and often contain
-- huge serialized payloads, so they should not dominate full-text search.

BEGIN;

CREATE OR REPLACE FUNCTION tower_message_search_document(content text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  parsed jsonb;
  block jsonb;
  parts text[] := ARRAY[]::text[];
  raw text := COALESCE(content, '');
BEGIN
  IF raw = '' THEN
    RETURN '';
  END IF;

  BEGIN
    parsed := raw::jsonb;
  EXCEPTION WHEN others THEN
    parsed := NULL;
  END;

  IF jsonb_typeof(parsed) = 'array' THEN
    FOR block IN SELECT value FROM jsonb_array_elements(parsed) LOOP
      IF block->>'type' = 'text' AND COALESCE(block->>'text', '') <> '' THEN
        parts := parts || (block->>'text');
      ELSIF block->>'type' = 'agent_run' THEN
        parts := parts || CONCAT_WS(' ', block->>'workerName', block->>'summary');
      END IF;
    END LOOP;
    raw := array_to_string(parts, ' ');
  END IF;

  SELECT COALESCE(string_agg(token, ' '), '')
    INTO raw
    FROM regexp_split_to_table(raw, '\s+') AS token
    WHERE token !~ '^https?://'
      AND length(token) < 256;

  raw := regexp_replace(raw, '\s+', ' ', 'g');
  RETURN LEFT(TRIM(raw), 300000);
END;
$$;

DROP INDEX IF EXISTS idx_messages_search_tsv;

CREATE INDEX IF NOT EXISTS idx_messages_search_tsv
  ON messages USING GIN (
    to_tsvector('simple', tower_message_search_document(content))
  );

COMMIT;
