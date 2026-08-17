-- ============================================================
-- 046: chat_rooms.kind — distinguish user-managed rooms from system channels
--
-- The Tower channel (and future system channels) should not be confused
-- with user-created rooms. `room_type` already describes purpose
-- (team/project/dashboard); `kind` is orthogonal — it answers
-- "is this user-managed or system-managed?"
--
-- See: workspace/decisions/2026-05-04-tower-channel-and-persona.md
--      tower/docs/plans/2026-05-04-tower-channel-implementation.md
-- ============================================================

ALTER TABLE chat_rooms
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'user';

-- Valid values (app-level): 'user' | 'tower_system'
-- 'user'         — created by users, normal lifecycle (existing rows default here)
-- 'tower_system' — auto-managed AI channel; admin-only rename/archive

-- Enforce: at most ONE tower_system channel can exist (single-workspace model).
-- Future multi-workspace scoping would replace this with (workspace_id, kind).
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_rooms_tower_system_singleton
  ON chat_rooms (kind)
  WHERE kind = 'tower_system';

CREATE INDEX IF NOT EXISTS idx_chat_rooms_kind ON chat_rooms (kind);
