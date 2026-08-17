-- 069_messages_short_id.sql
--
-- URL 라우팅 Phase 3 — messages.short_id 컬럼 (issue #11).
-- 메시지 앵커 `/s/<sessionCode>#m-<msgShortId>` 를 위한 8자 base32 id.
--
-- 핵심 결정: globally unique 가 아니라 **(session_id, short_id) composite unique**.
-- anchor 는 세션 안에서만 의미가 있으므로 다른 세션에 같은 short_id 가 있어도 무해.
-- 27만건 backfill 에서 globally unique 시 birthday paradox 로 ~5% 충돌이지만
-- 세션당 평균 ~150건이면 충돌 확률 ≈ 1.3×10^-8 (사실상 0).
--
-- 알파벳·길이는 short-code.ts 와 동일 (8자, 31자 base32). 모듈 reuse.
--
-- 결정: workspace/decisions/2026-05-24-url-routing-phase-2-short-code.md
-- 후속: 메시지 앵커 결정문서 (작성 예정 — Phase 3 합의 결과)

ALTER TABLE messages ADD COLUMN IF NOT EXISTS short_id TEXT;

-- (session_id, short_id) composite partial unique — 세션 안에서만 unique
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_short_id
  ON messages(session_id, short_id)
  WHERE short_id IS NOT NULL;
