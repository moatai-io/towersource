-- ============================================================
-- 062: users.password_changed_at — JWT 토큰 invalidate 트리거
-- ============================================================
-- 결정: workspace/decisions/2026-05-20-members-name-affiliation-and-credentials.md
--
-- authMiddleware 가 JWT 의 iat 와 비교해 이전 토큰 거부.
-- 다음 시나리오에서 NOW() 로 갱신:
--   1. 사용자 본인 비번 변경 (POST /api/me/password)
--   2. admin 의 비번 reset (PATCH /api/admin/users/:id 의 password 필드)
--   3. admin 의 username 변경 (PATCH /api/admin/users/:id 의 username 필드)
--
-- 기존 row 는 created_at 으로 backfill (created_at 이전 토큰은 어차피 없음).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

UPDATE users
   SET password_changed_at = created_at
 WHERE password_changed_at IS NULL;

COMMENT ON COLUMN users.password_changed_at IS '자격증명(비번·username) 변경 시점. authMiddleware 가 JWT.iat 와 비교해 이전 토큰 거부.';
