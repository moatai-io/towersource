-- Current channel membership provenance + immutable participation history.
ALTER TABLE room_members
  ADD COLUMN IF NOT EXISTS invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE room_members
  ADD COLUMN IF NOT EXISTS membership_source TEXT NOT NULL DEFAULT 'legacy_unknown';

ALTER TABLE room_members DROP CONSTRAINT IF EXISTS room_members_membership_source_check;
ALTER TABLE room_members ADD CONSTRAINT room_members_membership_source_check CHECK (
  membership_source IN ('creator', 'manual_invite', 'legacy_project_backfill', 'system', 'legacy_unknown')
);

CREATE TABLE IF NOT EXISTS room_membership_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id          TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type       TEXT NOT NULL CHECK (event_type IN (
    'joined', 'rejoined', 'left', 'removed', 'role_changed',
    'ownership_transferred', 'legacy_backfilled'
  )),
  actor_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  membership_source TEXT,
  previous_role    TEXT,
  next_role        TEXT,
  reason           TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_room_membership_events_room_created
  ON room_membership_events(room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_room_membership_events_user_created
  ON room_membership_events(user_id, created_at DESC);

-- Backfill only facts we can establish. Everything else remains legacy_unknown.
UPDATE room_members rm
   SET membership_source = 'creator'
  FROM chat_rooms cr
 WHERE cr.id = rm.room_id
   AND cr.created_by = rm.user_id
   AND rm.role = 'owner';

UPDATE room_members rm
   SET membership_source = 'legacy_project_backfill'
  FROM chat_rooms cr, project_members pm
 WHERE cr.id = rm.room_id
   AND cr.legacy_origin_project_id IS NOT NULL
   AND pm.project_id = cr.legacy_origin_project_id
   AND pm.user_id = rm.user_id
   AND rm.membership_source = 'legacy_unknown';

INSERT INTO room_membership_events (
  room_id, user_id, event_type, actor_user_id, membership_source,
  previous_role, next_role, reason, created_at
)
SELECT rm.room_id, rm.user_id, 'legacy_backfilled', NULL, rm.membership_source,
       NULL, rm.role, 'Existing membership registered when immutable history was introduced', rm.joined_at
  FROM room_members rm
 WHERE NOT EXISTS (
   SELECT 1 FROM room_membership_events e
    WHERE e.room_id = rm.room_id AND e.user_id = rm.user_id
      AND e.event_type = 'legacy_backfilled'
 );

COMMENT ON TABLE room_membership_events IS
  'Append-only audit history for channel joins, exits, removals, rejoins, and role changes.';
