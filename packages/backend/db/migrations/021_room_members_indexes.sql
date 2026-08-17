-- ============================================================
-- 021: Room members — composite index for batched sidebar load
-- ============================================================
--
-- Added 2026-04-10 as part of the 100-user scale pass.
--
-- Context: listRooms() was rewritten to batch membership lookups with
--   SELECT room_id FROM room_members
--   WHERE user_id = $1 AND room_id = ANY($2::text[])
--
-- The existing indexes were:
--   PRIMARY KEY (room_id, user_id)      -- good for room-centric lookups
--   idx_room_members_user (user_id)     -- single column
--
-- Neither supports the new WHERE clause efficiently once users belong to
-- many rooms, because scanning by user_id still requires a heap fetch to
-- filter by room_id. A composite (user_id, room_id) index lets Postgres
-- satisfy the predicate with an index-only scan.

CREATE INDEX IF NOT EXISTS idx_room_members_user_room
  ON room_members (user_id, room_id);
