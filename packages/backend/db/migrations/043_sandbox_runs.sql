-- 043_sandbox_runs.sql — Phase 1b: 일회성 실행 감사 + 사용자별 토글
--
-- 결정: workspace/decisions/2026-04-24-execution-sandbox-scope.md (D3, D6, D8)
--       workspace/decisions/2026-04-26-execution-sandbox-phase1.md (1b)
--
-- 두 가지를 한 번에:
--   1. users.sandbox_enabled — 4계층 토글의 3단계 (사용자 레벨)
--   2. sandbox_runs — 일회성 실행 감사 로그

-- ── 1) users 테이블에 sandbox_enabled 추가 ────────────────────────────
-- default false: 활성화는 admin 이 명시적으로 해야 함 (Q1 결정 전까지 보수적)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS sandbox_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN users.sandbox_enabled IS
  '4계층 토글의 3단계 — 이 사용자가 sandbox.run 도구를 호출할 수 있는가. '
  'admin 이 Admin 패널에서 명시적으로 켜야 함. '
  '결정: workspace/decisions/2026-04-24-execution-sandbox-scope.md (D8 4계층 토글)';

-- ── 2) sandbox_runs — 일회성 실행 감사 로그 ────────────────────────────
CREATE TABLE IF NOT EXISTS sandbox_runs (
  id              BIGSERIAL PRIMARY KEY,

  -- 누가 / 어디서
  user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id      TEXT,                                -- nullable (channel ai 등)

  -- 무엇
  runtime         TEXT NOT NULL,                       -- 'python' | 'node' | 'bash'
  command_hash    TEXT,                                -- SHA256(code) — 자주 쓰는 코드 식별용
  command_text    TEXT,                                -- 짧으면 인라인 (≤ 8KB)
  command_size    INT,                                 -- 원본 코드 바이트
  timeout_sec     INT NOT NULL,                        -- 요청 timeout

  -- 언제
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  duration_ms     INT,                                 -- finished_at - started_at

  -- 결과
  exit_code       INT,
  oom_killed      BOOLEAN DEFAULT false,
  timed_out       BOOLEAN DEFAULT false,

  -- 사용량
  cpu_seconds     NUMERIC(10, 3),                      -- docker stats 추정 (선택)
  peak_memory_mb  INT,                                 -- OOMKilled 시 limit 값
  stdout_bytes    INT DEFAULT 0,
  stderr_bytes    INT DEFAULT 0,

  -- 산출물 (Phase 1c 의 scratch 회수)
  scratch_files   JSONB DEFAULT '[]'::jsonb,           -- [{name, size, mime, download_url}]

  -- 에러 추적
  error_text      TEXT,                                -- ssh 실패 / 알 수 없는 에러 등

  -- 제약
  CONSTRAINT sandbox_runs_runtime_chk CHECK (
    runtime IN ('python', 'python-data', 'node', 'node-utils', 'bash')
  )
);

-- 사용자별 최근 실행 조회용
CREATE INDEX IF NOT EXISTS sandbox_runs_user_started_idx
  ON sandbox_runs (user_id, started_at DESC);

-- 세션별 (인라인 카드 표시용)
CREATE INDEX IF NOT EXISTS sandbox_runs_session_started_idx
  ON sandbox_runs (session_id, started_at DESC)
  WHERE session_id IS NOT NULL;

-- 활성 (finished_at IS NULL) — 동시 실행 cap 카운트용
CREATE INDEX IF NOT EXISTS sandbox_runs_active_user_idx
  ON sandbox_runs (user_id)
  WHERE finished_at IS NULL;

-- 감사 / 통계 — 최근 24h 모니터링용 (started_at 기반)
CREATE INDEX IF NOT EXISTS sandbox_runs_started_idx
  ON sandbox_runs (started_at DESC);

COMMENT ON TABLE sandbox_runs IS
  'Phase 1 sandbox.run() 일회성 실행 감사 로그. '
  '동시 실행 cap (사용자당 2개 default) 은 finished_at IS NULL 행 카운트로 enforce. '
  'retention: 90일 (cron 으로 정리 예정).';

-- ── 3) 향후 (Phase 2) — internal_tools 는 별도 마이그레이션 ────────────
-- 044_internal_tools.sql 에서 추가 예정. 이번엔 Phase 1b 만 커버.
