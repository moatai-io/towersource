-- 071_room_messages_short_id.sql
--
-- URL 라우팅 Phase 3 확장 — room_messages.short_id (issue #11).
-- 채널 메시지 앵커 `/r/<roomShortCode>#m-<msgShortId>` 를 위한 8자 base32 id.
-- (room_id, short_id) composite unique — 채널 안에서만 unique 면 충분.
--
-- 결정: workspace/decisions/2026-05-24-url-routing-phase-2-short-code.md
--       sessions/messages 의 short_id 패턴을 room_messages 에 확장.

ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS short_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_room_messages_room_short_id
  ON room_messages(room_id, short_id)
  WHERE short_id IS NOT NULL;
