-- Preserve the Project-origin meaning that existed before people-centered channels.
-- Existing duplicate names remain untouched; new/renamed active user channels are
-- guarded in application code because a unique index would invalidate legacy rows.
ALTER TABLE chat_rooms
  ADD COLUMN IF NOT EXISTS legacy_origin_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE chat_rooms
  ADD COLUMN IF NOT EXISTS legacy_origin_migrated_at TIMESTAMPTZ;

-- Migration 117 inserted old chat_rooms.project_id links at one shared timestamp.
-- A link created in that migration is historical origin, while later links are
-- current shares only. Capture the earliest matching backfill record once.
WITH migration_time AS (
  SELECT MIN(m.applied_at) AS applied_at
    FROM _migrations m
   WHERE m.version = '117_channel_resource_links'
      OR m.name = '117_channel_resource_links.sql'
), origins AS (
  SELECT DISTINCT ON (crl.channel_id)
         crl.channel_id, crl.resource_id, crl.created_at
    FROM channel_resource_links crl
    JOIN migration_time mt ON crl.created_at = mt.applied_at
   WHERE crl.resource_type = 'project'
   ORDER BY crl.channel_id, crl.created_at, crl.id
)
UPDATE chat_rooms cr
   SET legacy_origin_project_id = origins.resource_id,
       legacy_origin_migrated_at = origins.created_at
  FROM origins
 WHERE cr.id = origins.channel_id
   AND cr.legacy_origin_project_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_chat_rooms_legacy_origin
  ON chat_rooms(legacy_origin_project_id)
  WHERE legacy_origin_project_id IS NOT NULL;

COMMENT ON COLUMN chat_rooms.legacy_origin_project_id IS
  'Historical Project origin before people-centered channel migration. Informational only; never grants current access.';
