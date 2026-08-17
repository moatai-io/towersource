-- 067_sessions_short_code.sql
--
-- URL 라우팅 Phase 2 — short_code 컬럼 추가 (issue #11).
-- 36자 raw UUID 를 8자 base32 로 치환해서 주소창·외부 공유 시 ID leak 줄이고
-- 사람이 읽기 쉽게. 기존 UUID 는 영구 수용(하위호환), URL 은 자동 업그레이드.
--
-- 결정: workspace/decisions/2026-05-24-url-routing-phase-2-short-code.md
--
-- 알파벳 31자 base32 (모호문자 0/o, 1/l/i, u 제외): 23456789abcdefghjkmnpqrstvwxyz
-- 길이 8 → 공간 31^8 ≈ 8.5×10^11
--
-- backfill 은 앱 부팅 시 일괄(NULL → generated) — 단일 진실 (TS 한 곳).
-- 마이그레이션은 컬럼 + partial unique index 만.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS short_code TEXT;

-- partial unique index — NULL 다중 허용, 값 있으면 unique
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_short_code
  ON sessions(short_code)
  WHERE short_code IS NOT NULL;
