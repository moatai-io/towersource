-- Migration 028 — skill_providers를 skill_name 기반으로 재설계
--
-- 배경: 2026-04-17 skill-db-simplification 결정
--   (workspace/decisions/2026-04-17-skill-db-simplification.md)
-- company 스킬을 DB에서 제거하고 library.yaml + ~/.claude/skills/<name>/SKILL.md 를
-- 단일 소스로 사용하도록 전환. skill_providers는 기존 skill_id(UUID) 대신
-- skill_name(TEXT)을 natural key로 사용하도록 스키마 교체.
--
-- 데이터 영향:
--   - 기존 skill_providers 2행(gws+google, 고아+google)은 버려지고, 서버 기동 시
--     library.yaml의 각 SKILL.md frontmatter에서 providers 블록을 다시 파싱하여
--     skill_name 기반으로 재생성됨.
--   - 고아 행(skill_registry에 존재하지 않는 skill_id)은 자연히 소멸.
--
-- Rollback 시 주의: user_skill_readiness 뷰도 같이 재생성됨.

BEGIN;

-- 1) 기존 뷰 제거 (테이블을 드롭하려면 선행 제거 필요)
DROP VIEW IF EXISTS user_skill_readiness;

-- 2) 기존 테이블 제거 — 2행만 있었고 부트 시 library.yaml에서 재생성됨
DROP TABLE IF EXISTS skill_providers;

-- 3) 새 테이블 — skill_name 기반
CREATE TABLE skill_providers (
  skill_name  TEXT NOT NULL,
  provider    TEXT NOT NULL,
  required    BOOLEAN DEFAULT true,
  scope_hint  TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (skill_name, provider)
);

CREATE INDEX idx_sp_provider ON skill_providers(provider);

-- 4) user_skill_prefs 도 skill_name 기반으로 전환
--    (library 스킬은 UUID가 없어서 기존 FK 기반 참조가 동작하지 않음)
--    현재 데이터 0행이므로 drop-and-recreate 방식이 가장 깔끔.
DROP TABLE IF EXISTS user_skill_prefs;
CREATE TABLE user_skill_prefs (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  enabled    INTEGER DEFAULT 1,
  PRIMARY KEY (user_id, skill_name)
);

-- 5) 뷰 재생성 — skill_registry 참조 제거, skill_name + user_oauth_tokens 직접 조인
CREATE OR REPLACE VIEW user_skill_readiness AS
SELECT
  sp.skill_name,
  sp.provider,
  sp.required,
  sp.scope_hint,
  uot.user_id,
  CASE WHEN uot.access_token IS NOT NULL THEN true ELSE false END AS connected
FROM skill_providers sp
LEFT JOIN user_oauth_tokens uot ON sp.provider = uot.provider;

COMMIT;
