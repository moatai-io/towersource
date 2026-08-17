-- 075_project_runtime_boxes.sql — Project Runtime Box v1 스키마
--
-- 결정:
--   workspace/decisions/2026-06-01-project-runtime-plane-devbox-services.md
--   workspace/decisions/2026-06-02-project-runtime-box-product-framing.md
--
-- 두 테이블:
--   1. project_runtime_boxes  — 프로젝트당 공유 개발 컨테이너 (Box)
--   2. runtime_box_services   — Box 안에서 뜬 장기 실행 서비스 레지스트리
--
-- v1 범위:
--   - 프로젝트당 Box 1개 (UNIQUE project_id)
--   - on-demand start / idle stop
--   - 프로젝트 폴더 rw mount (구현은 runtime-box-manager.ts 에서 Docker)
--   - service registry: 포트·로그·TTL·pin 메타
--
-- v2+ 범위 (이 마이그레이션에선 columns 만 예약, 구현 없음):
--   - secure_mode: overlay / microVM 승격
--   - session_overlay: 세션별 임시 분기 (LATER)
--   - cross-project service ACL (LATER)

-- ─────────────────────────────────────────────────────────────────────────
-- 1. project_runtime_boxes
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_runtime_boxes (
  id              BIGSERIAL PRIMARY KEY,

  -- 프로젝트 연결 (1:1)
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- 컨테이너 상태
  -- 'stopped' | 'starting' | 'running' | 'idle_stopped' | 'error'
  status          TEXT NOT NULL DEFAULT 'stopped',

  -- 런타임 프로필 (어떤 Docker image 를 쓸지)
  -- 'node20-python312' | 'python312' | 'node20' | 'custom'
  runtime_profile TEXT NOT NULL DEFAULT 'node20-python312',

  -- 컨테이너 ID (Docker) — running 상태일 때만 유효
  container_id    TEXT,

  -- 프로젝트 폴더 경로 (호스트 절대경로) — rw mount target
  -- 예: /home/tower/workspace/projects/my-app
  project_root    TEXT NOT NULL,

  -- Resource limits
  memory_mb       INT NOT NULL DEFAULT 3072,        -- 3GB default / cap by app config
  cpu_limit       NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  pids_limit      INT NOT NULL DEFAULT 512,
  disk_quota_mb   INT NOT NULL DEFAULT 10240,       -- 10GB

  -- Lifecycle
  idle_stop_minutes INT NOT NULL DEFAULT 20,        -- 비활성 시 종료 기준
  last_active_at  TIMESTAMPTZ,                      -- 마지막 exec 시각
  started_at      TIMESTAMPTZ,
  stopped_at      TIMESTAMPTZ,

  -- 오류 기록
  last_error      TEXT,
  error_at        TIMESTAMPTZ,

  -- 감사
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      INT REFERENCES users(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- v2+ 예약 컬럼 (NULL = 미사용)
  secure_mode     TEXT,                             -- 'overlay' | 'microvm' (Phase 3+)
  network_policy  TEXT,                             -- JSON: 미래 정책 config

  CONSTRAINT project_runtime_boxes_status_chk CHECK (
    status IN ('stopped', 'starting', 'running', 'idle_stopped', 'error')
  ),
  CONSTRAINT project_runtime_boxes_profile_chk CHECK (
    runtime_profile IN ('node20-python312', 'python312', 'node20', 'custom')
  )
);

-- 프로젝트당 Box 1개 (v1 정책)
CREATE UNIQUE INDEX IF NOT EXISTS project_runtime_boxes_project_unique
  ON project_runtime_boxes (project_id);

-- running box 빠른 조회 (idle stop cron, dashboard)
CREATE INDEX IF NOT EXISTS project_runtime_boxes_status_idx
  ON project_runtime_boxes (status)
  WHERE status IN ('running', 'starting');

COMMENT ON TABLE project_runtime_boxes IS
  'Project Runtime Box v1 — 프로젝트당 공유 개발 컨테이너. '
  '프로젝트 폴더를 rw mount 하고 shell semantics 를 최대한 유지. '
  '결정: workspace/decisions/2026-06-02-project-runtime-box-product-framing.md';

COMMENT ON COLUMN project_runtime_boxes.project_root IS
  '호스트 파일시스템의 프로젝트 폴더 절대경로. '
  'Docker bind mount 의 source 로 사용. 컨테이너 내부에선 /workspace 로 노출. '
  '경계: 이 경로 이상으로 mount 금지 — 다른 프로젝트 또는 호스트 루트 접근 방지.';

COMMENT ON COLUMN project_runtime_boxes.idle_stop_minutes IS
  '마지막 exec 이후 이 분 동안 활동 없으면 컨테이너 stop. '
  'cache volume 은 유지 — 다음 start 시 npm/pip 재설치 불필요.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. runtime_box_services
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS runtime_box_services (
  id              BIGSERIAL PRIMARY KEY,

  -- 소속
  box_id          BIGINT NOT NULL REFERENCES project_runtime_boxes(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- 서비스 식별
  name            TEXT NOT NULL,                    -- 'dev', 'api', 'worker-indexer'
  display_name    TEXT,

  -- 실행 정보
  command         TEXT NOT NULL,                    -- 'npm run dev'
  cwd             TEXT NOT NULL DEFAULT '/workspace',

  -- 네트워크
  internal_port   INT,                              -- 컨테이너 내부 포트
  host_port       INT,                              -- 호스트 바인딩 포트 (40000 + id % 20000)
  external_url    TEXT,                             -- nginx proxy 후 공개 URL

  -- 상태
  -- 'pending' | 'running' | 'stopped' | 'error' | 'expired'
  status          TEXT NOT NULL DEFAULT 'pending',

  -- 노출 범위
  -- 'private' | 'project-internal' | 'auth-required' | 'unlisted' | 'public'
  visibility      TEXT NOT NULL DEFAULT 'private',

  -- 라이프사이클
  pinned          BOOLEAN NOT NULL DEFAULT false,
  purpose         TEXT,                             -- pinned 서비스 필수 메모
  owner_user_id   INT REFERENCES users(id),

  ttl_hours       INT NOT NULL DEFAULT 2,           -- 기본 TTL (pinned=false 시 적용)
  review_after    TIMESTAMPTZ,                      -- pinned 서비스 리뷰 일정

  started_at      TIMESTAMPTZ,
  stopped_at      TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  last_active_at  TIMESTAMPTZ,                      -- 마지막 HTTP hit 시각

  -- 감사
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      INT REFERENCES users(id),

  -- 오류 기록
  last_error      TEXT,

  CONSTRAINT runtime_box_services_status_chk CHECK (
    status IN ('pending', 'running', 'stopped', 'error', 'expired')
  ),
  CONSTRAINT runtime_box_services_visibility_chk CHECK (
    visibility IN ('private', 'project-internal', 'auth-required', 'unlisted', 'public')
  )
);

-- box 내에서 name unique
CREATE UNIQUE INDEX IF NOT EXISTS runtime_box_services_box_name_unique
  ON runtime_box_services (box_id, name);

-- running 서비스 조회 (TTL cron, registry list)
CREATE INDEX IF NOT EXISTS runtime_box_services_status_idx
  ON runtime_box_services (project_id, status)
  WHERE status = 'running';

-- pinned 서비스 리뷰 (review_after cron)
CREATE INDEX IF NOT EXISTS runtime_box_services_pinned_review_idx
  ON runtime_box_services (review_after)
  WHERE pinned = true AND status = 'running';

COMMENT ON TABLE runtime_box_services IS
  'Project Runtime Box 안에서 실행 중인 장기 서비스 레지스트리. '
  'npm run dev, uvicorn, node server.js 등이 Service 로 승격될 때 등록. '
  'pinned=true 는 자동 TTL stop 제외 — owner/purpose/review_after 필수. '
  '결정: workspace/decisions/2026-06-01-project-runtime-plane-devbox-services.md §Pinned Service';

COMMENT ON COLUMN runtime_box_services.pinned IS
  '영구 서버가 아니라 "Tower 가 책임지고 추적하는 장기 서비스". '
  '자동 idle stop 대상은 아니지만 review_after 에 owner 확인 요구. '
  'pinned=true 에는 purpose 필드가 NOT NULL 수준으로 강하게 권장됨.';
