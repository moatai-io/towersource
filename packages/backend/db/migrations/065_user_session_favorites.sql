-- 065_user_session_favorites.sql
-- 세션 즐겨찾기를 사용자별로 분리.
--
-- 기존: sessions.favorite 컬럼 (글로벌) — 한 사용자가 별 켜면 모두에게 보임 (버그).
-- 신규: user_session_favorites 별도 테이블로 다대다 매핑.
--
-- sessions.favorite 컬럼은 legacy 로 남겨둠 (rollback 안전 + 다음 정리 migration
-- 에서 drop). 백엔드 코드는 더 이상 읽지 않음.
--
-- 결정: workspace/decisions/2026-05-22-per-user-session-favorites.md
-- 선례: user_project_pins (064_user_project_pins.sql, 2026-04-26)

BEGIN;

CREATE TABLE IF NOT EXISTS user_session_favorites (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, session_id)
);

-- "이 사용자가 favorite 한 세션들" 조회용 — 사이드바 매번 부름
CREATE INDEX IF NOT EXISTS idx_user_session_favorites_user
  ON user_session_favorites (user_id);

-- "이 세션을 favorite 한 사용자들" 역방향 조회 (검색 가중치 등)
CREATE INDEX IF NOT EXISTS idx_user_session_favorites_session
  ON user_session_favorites (session_id);

-- Backfill: 기존 sessions.favorite=1 인 row 를 owner 기준으로 옮김.
-- owner(user_id) 가 NULL 인 경우 skip — channel_ai 같은 시스템 세션 즐겨찾기는
-- 의미 없음.
INSERT INTO user_session_favorites (user_id, session_id, created_at)
SELECT s.user_id, s.id, COALESCE(s.updated_at, NOW())
FROM sessions s
WHERE s.favorite = 1 AND s.user_id IS NOT NULL
ON CONFLICT (user_id, session_id) DO NOTHING;

COMMIT;
