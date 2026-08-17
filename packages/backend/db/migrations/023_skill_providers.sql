-- Skill Credential Binding: 스킬이 필요로 하는 provider 선언 테이블
-- 예: gmail 스킬 → provider='google', required=true

CREATE TABLE IF NOT EXISTS skill_providers (
  skill_id    TEXT NOT NULL,
  provider    TEXT NOT NULL,
  required    BOOLEAN DEFAULT true,
  scope_hint  TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (skill_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_sp_provider ON skill_providers(provider);

-- 사용자별 연결 현황 빠른 조회를 위한 뷰 (선택적 사용)
CREATE OR REPLACE VIEW user_skill_readiness AS
SELECT
  sr.id AS skill_id,
  sr.name AS skill_name,
  sr.scope,
  sp.provider,
  sp.required,
  sp.scope_hint,
  uot.user_id,
  CASE WHEN uot.access_token IS NOT NULL THEN true ELSE false END AS connected
FROM skill_registry sr
JOIN skill_providers sp ON sr.id = sp.skill_id
LEFT JOIN user_oauth_tokens uot ON sp.provider = uot.provider;
