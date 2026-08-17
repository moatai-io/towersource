-- 064_user_project_pins.sql
-- 사용자별 프로젝트 상단 고정 및 고정 영역 수동 순서.
--
-- 프로젝트 자체 sort_order 는 팀/전역 정렬 의미로 남기고, 왼쪽 세션 리스트의
-- "고정" 영역은 user_project_pins 로 개인별 저장한다.

BEGIN;

CREATE TABLE IF NOT EXISTS user_project_pins (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_user_project_pins_user_order
  ON user_project_pins (user_id, sort_order);

COMMIT;
