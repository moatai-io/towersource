-- 070_chat_rooms_short_code.sql
--
-- URL 라우팅 Phase 2 확장 — chat_rooms.short_code (issue #11).
-- 채널 deep link `/r/<shortCode>` 를 위한 8자 base32 id. sessions.short_code 와
-- 같은 패턴(알파벳, 길이, 충돌 정책). 24개 row 라 backfill 즉시 끝남.
--
-- 결정: workspace/decisions/2026-05-24-url-routing-phase-2-short-code.md
--       (sessions 의 short_code 패턴을 chat_rooms 에 확장)

ALTER TABLE chat_rooms ADD COLUMN IF NOT EXISTS short_code TEXT;

-- partial unique index — NULL 다중 허용, 값 있으면 unique (globally — rooms 는 적음)
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_rooms_short_code
  ON chat_rooms(short_code)
  WHERE short_code IS NOT NULL;
