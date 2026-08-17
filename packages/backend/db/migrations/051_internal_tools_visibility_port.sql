-- 051_internal_tools_visibility_port.sql — Phase 2a-1 활성화
--
-- 결정:
--   workspace/decisions/2026-04-29-execution-sandbox-q13-tool-start-api.md
--   workspace/decisions/2026-05-02-execution-sandbox-q18-public-tools.md
--   workspace/decisions/2026-05-06-execution-sandbox-q19-port-allocation.md
--
-- internal_tools 테이블에 다음 추가:
--   1. visibility — 'private' | 'auth-required' | 'unlisted' | 'public'
--      Phase 2a-1 은 'private' 만 동작. 다른 값은 045 row 삽입 시 검증.
--   2. host_port — sandbox VM 의 호스트 포트 (자동 할당). nginx upstream 이 사용.
--   3. python-web 런타임 추가 — internal_tools_runtime_chk 갱신 (050 와 동일 패턴)
--
-- 044 마이그레이션이 internal_tools 를 만들어두었지만 빈 테이블이므로 ALTER 부담 0.

-- ── 1) visibility 컬럼 ────────────────────────────────────────────────────
ALTER TABLE internal_tools
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';

ALTER TABLE internal_tools DROP CONSTRAINT IF EXISTS internal_tools_visibility_chk;
ALTER TABLE internal_tools ADD CONSTRAINT internal_tools_visibility_chk CHECK (
  visibility IN ('private', 'auth-required', 'unlisted', 'public')
);

COMMENT ON COLUMN internal_tools.visibility IS
  'Phase 2a-1 = private only. 2a-2 adds auth-required (nginx + session cookie). '
  '2a-3 adds unlisted (random suffix) + public (named, indexed). '
  '결정: workspace/decisions/2026-05-02-execution-sandbox-q18-public-tools.md';

-- ── 2) host_port 컬럼 (Q19 작업 가설: 40000 + id) ──────────────────────────
ALTER TABLE internal_tools
  ADD COLUMN IF NOT EXISTS host_port INT;

CREATE UNIQUE INDEX IF NOT EXISTS internal_tools_host_port_unique
  ON internal_tools (host_port)
  WHERE host_port IS NOT NULL AND status IN ('pending', 'running');

COMMENT ON COLUMN internal_tools.host_port IS
  'Sandbox VM host port — bound 127.0.0.1:host_port:container_port. '
  'Auto-assigned. Unique among pending/running tools. '
  '결정: workspace/decisions/2026-05-06-execution-sandbox-q19-port-allocation.md';

-- ── 3) python-web 런타임 허용 (050 와 일관) ────────────────────────────────
ALTER TABLE internal_tools DROP CONSTRAINT IF EXISTS internal_tools_runtime_chk;
ALTER TABLE internal_tools ADD CONSTRAINT internal_tools_runtime_chk CHECK (
  runtime IN ('python', 'python-data', 'python-web', 'node', 'node-utils', 'bash')
);

-- ── 4) 운영 인덱스 (visibility 별 lookup) ──────────────────────────────────
CREATE INDEX IF NOT EXISTS internal_tools_visibility_status_idx
  ON internal_tools (visibility, status)
  WHERE status = 'running';
