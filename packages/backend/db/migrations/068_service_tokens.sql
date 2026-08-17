-- 068_service_tokens.sql — fleet service token audit table
--
-- 결정: workspace/decisions/2026-05-27-fleet-service-tokens.md
-- 이슈: https://github.com/juliuschun/tower/issues/36
--
-- generateScopedToken 으로 발급된 long-lived service token 의 audit row.
-- pm-capture 의 'ideas' scope 같은 15분짜리 tokens 는 audit 안 함 — 본 테이블은
-- fleet (90일) 처럼 *발급/회전/회수* 가 필요한 토큰 전용.
--
-- 컬럼:
--   jti           JWT ID claim. token 식별자. revocation 단위.
--   aud           scope claim (예: 'fleet'). SCOPE_PREFIXES 의 key.
--   user_id       self-hosted server 의 어느 user 명의로 발급됐는지 (보통 admin).
--   issued_for    operator-side 식별자 (예: 'julius@openclaw-vm'). 추적용.
--   issued_at     발급 시각.
--   expires_at    만료 시각 (JWT exp claim 과 동일).
--   revoked_at    회수 시각. NULL 이면 활성.
--   last_used_at  authMiddleware 가 매 호출시 갱신 (60초 throttled).

CREATE TABLE IF NOT EXISTS service_tokens (
  jti           TEXT PRIMARY KEY,
  aud           TEXT NOT NULL,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_for    TEXT NOT NULL,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_service_tokens_aud_active
  ON service_tokens (aud)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_service_tokens_user
  ON service_tokens (user_id);

COMMENT ON TABLE service_tokens IS
  'Long-lived scoped JWT audit (fleet 등). Short-lived (pm-capture ideas) 는 제외.';
COMMENT ON COLUMN service_tokens.jti IS
  'JWT jti claim. revocation 의 단위.';
COMMENT ON COLUMN service_tokens.issued_for IS
  'operator-side 식별자 (예: julius@openclaw-vm). audit 추적용.';
