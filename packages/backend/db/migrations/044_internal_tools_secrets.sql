-- 044_internal_tools_secrets.sql — Phase 2a 사전 준비
--
-- 결정:
--   workspace/decisions/2026-04-28-execution-sandbox-d1-revisited.md (B + Phase 2 절충)
--   workspace/decisions/2026-04-29-execution-sandbox-q12-secrets.md (secret_store + grants)
--   workspace/decisions/2026-04-29-execution-sandbox-q13-tool-start-api.md (internal_tools)
--
-- Phase 2a 가 활성되기 전에 스키마만 미리 박아둠. 코드(services/sandbox-tools.ts,
-- services/secret-store.ts) 는 Phase 2a 진입 시점에 추가. 이 마이그레이션 자체는
-- 무해 — 사용 안 하면 빈 테이블만 있음.

-- ── 1) sandbox_runs 에 secrets_used 컬럼 추가 (Q12 감사) ─────────────────
ALTER TABLE sandbox_runs
  ADD COLUMN IF NOT EXISTS secrets_used JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN sandbox_runs.secrets_used IS
  'Secret names this run requested (values never stored). '
  'e.g. ["OPENAI_API_KEY", "SLACK_BOT_TOKEN"]. '
  '결정: workspace/decisions/2026-04-29-execution-sandbox-q12-secrets.md';

-- ── 2) secret_store — 암호화된 값 보관 ──────────────────────────────────
CREATE TABLE IF NOT EXISTS secret_store (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,                       -- e.g. 'OPENAI_API_KEY'
  value_encrypted BYTEA NOT NULL,                      -- AES-GCM with master key from .env
  scope           TEXT NOT NULL,                       -- 'global' | 'user' | 'tool'
  owner_user_id   INT REFERENCES users(id) ON DELETE CASCADE,
  owner_tool_id   BIGINT,                              -- internal_tools.id (FK 후행 ALTER)
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      INT REFERENCES users(id),
  rotated_at      TIMESTAMPTZ,
  CONSTRAINT secret_store_scope_chk CHECK (scope IN ('global', 'user', 'tool')),
  CONSTRAINT secret_store_unique UNIQUE (name, scope, owner_user_id, owner_tool_id)
);

CREATE INDEX IF NOT EXISTS secret_store_scope_idx ON secret_store (scope);
CREATE INDEX IF NOT EXISTS secret_store_user_idx ON secret_store (owner_user_id) WHERE owner_user_id IS NOT NULL;

COMMENT ON TABLE secret_store IS
  'Encrypted secrets (API keys, tokens) for sandbox runs and internal tools. '
  'Master key from .env (SECRET_STORE_MASTER_KEY). AES-GCM 256-bit. '
  '결정: workspace/decisions/2026-04-29-execution-sandbox-q12-secrets.md';

-- ── 3) secret_grants — ACL: 누가 어떤 secret 쓸 수 있나 ─────────────────
CREATE TABLE IF NOT EXISTS secret_grants (
  secret_id   BIGINT NOT NULL REFERENCES secret_store(id) ON DELETE CASCADE,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by  INT REFERENCES users(id),
  PRIMARY KEY (secret_id, user_id)
);

CREATE INDEX IF NOT EXISTS secret_grants_user_idx ON secret_grants (user_id);

-- ── 4) internal_tools — 장기 운영 컨테이너 등록제 (Q13) ─────────────────
CREATE TABLE IF NOT EXISTS internal_tools (
  id              BIGSERIAL PRIMARY KEY,

  -- 소유 + 식별
  owner_user_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,

  -- 코드 + 런타임 (D11 분리 원칙)
  workspace_path  TEXT NOT NULL,                       -- 'projects/foo'
  entrypoint      TEXT NOT NULL,                       -- 'python main.py'
  runtime         TEXT NOT NULL,
  image           TEXT NOT NULL,                       -- 해석된 docker image

  -- 자원 cap
  cpu_limit       NUMERIC(4,2) DEFAULT 0.25,
  memory_mb       INT DEFAULT 256,

  -- 외부 노출 (Q14 nginx proxy)
  port            INT,
  proxy_subdomain TEXT,                                -- 'julius-kakao-cron'

  -- Secrets (Q12) — 이름만 기록
  secrets_used    JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- 환경 (평문 env, secret 아님)
  env_plain       JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- 컨테이너 상태
  container_id    TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',

  -- 라이프사이클
  restart_policy  TEXT DEFAULT 'unless-stopped',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  stopped_at      TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL,
  last_renewed_at TIMESTAMPTZ,

  -- 감사 / 운영
  cpu_seconds_total NUMERIC(12,3) NOT NULL DEFAULT 0,
  peak_memory_mb    INT,
  restart_count     INT NOT NULL DEFAULT 0,
  last_error        TEXT,

  CONSTRAINT internal_tools_runtime_chk CHECK (
    runtime IN ('python', 'python-data', 'node', 'node-utils', 'bash')
  ),
  CONSTRAINT internal_tools_status_chk CHECK (
    status IN ('pending', 'running', 'stopped', 'error', 'expired')
  ),
  CONSTRAINT internal_tools_owner_name_unique UNIQUE (owner_user_id, name)
);

CREATE INDEX IF NOT EXISTS internal_tools_owner_status_idx
  ON internal_tools (owner_user_id, status);

CREATE INDEX IF NOT EXISTS internal_tools_running_expires_idx
  ON internal_tools (status, expires_at)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS internal_tools_proxy_idx
  ON internal_tools (proxy_subdomain)
  WHERE proxy_subdomain IS NOT NULL;

COMMENT ON TABLE internal_tools IS
  'Phase 2 long-running internal containers (FastAPI mini-backends, workers). '
  'Lifecycle: pending → running → (stopped|expired|error). expires_at default 7d. '
  '결정: workspace/decisions/2026-04-29-execution-sandbox-q13-tool-start-api.md';

-- ── 5) secret_store.owner_tool_id 의 FK 추가 (forward reference 해소) ──
ALTER TABLE secret_store
  ADD CONSTRAINT secret_store_tool_fk
  FOREIGN KEY (owner_tool_id)
  REFERENCES internal_tools(id)
  ON DELETE CASCADE
  NOT VALID;

-- NOT VALID 로 추가하고 즉시 VALIDATE — 빈 테이블이라 즉시 통과
ALTER TABLE secret_store VALIDATE CONSTRAINT secret_store_tool_fk;

-- ── 6) 향후 Phase 2c 의 청소 cron 이 사용할 view ───────────────────────
-- 만료된 도구 빠른 식별
CREATE OR REPLACE VIEW v_expired_tools AS
SELECT id, owner_user_id, name, container_id, expires_at,
       (now() - expires_at) AS overdue
FROM internal_tools
WHERE status = 'running' AND expires_at < now();

COMMENT ON VIEW v_expired_tools IS
  '만료됐지만 아직 stop 안 된 도구 목록. Phase 2c cron 이 polling.';
