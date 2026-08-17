-- 093: Personal AI channels for private Tower Noti delivery
--
-- Tower Noti should default to a user-private channel, not the workspace-wide
-- Tower/system channel. `personal_ai` rooms are ordinary non-project rooms
-- with exactly one owner by default; users may explicitly invite others later.

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_rooms_personal_ai_owner
  ON chat_rooms (created_by)
  WHERE kind = 'personal_ai' AND (archived IS NULL OR archived = 0);

CREATE INDEX IF NOT EXISTS idx_chat_rooms_personal_ai_kind
  ON chat_rooms (kind, created_by)
  WHERE kind = 'personal_ai';
