-- 117: People-centered channels can reference zero or more project resources.
-- Initially introduced as a context reference; migration 121 clarifies the final
-- product contract that an active link is an explicit channel share grant.
CREATE TABLE IF NOT EXISTS channel_resource_links (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  channel_id    TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL DEFAULT 'project' CHECK (resource_type IN ('project')),
  resource_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  capability    TEXT NOT NULL DEFAULT 'read' CHECK (capability IN ('discover', 'read', 'write')),
  added_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ,
  UNIQUE (channel_id, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_resource_links_channel
  ON channel_resource_links(channel_id, created_at ASC)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_channel_resource_links_resource
  ON channel_resource_links(resource_type, resource_id, channel_id)
  WHERE revoked_at IS NULL;

-- Preserve existing single-project channels as resource links, then remove the
-- project ownership meaning. From this migration onward room membership is the
-- visibility boundary and projects are separately linked resources.
INSERT INTO channel_resource_links (channel_id, resource_type, resource_id, capability, added_by)
SELECT cr.id, 'project', cr.project_id, 'read', cr.created_by
  FROM chat_rooms cr
 WHERE cr.project_id IS NOT NULL
ON CONFLICT (channel_id, resource_type, resource_id) DO NOTHING;

UPDATE chat_rooms SET project_id = NULL WHERE project_id IS NOT NULL;

COMMENT ON TABLE channel_resource_links IS
  'Resources linked to a people-centered channel. See migration 121 for the explicit channel share contract.';
