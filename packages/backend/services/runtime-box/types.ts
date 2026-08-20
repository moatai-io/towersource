/**
 * types.ts — Project Runtime Box v1 공유 타입 정의.
 *
 * Owns: Box / Service / Exec 관련 타입.
 * Public API: BoxStatus, ServiceStatus, RuntimeProfile, BoxRow, ServiceRow,
 *             ExecRequest, ExecResult, ServiceRegisterRequest.
 * See README.md.
 */

// ── Box 상태 ─────────────────────────────────────────────────────────────

export type BoxStatus =
  | 'stopped'       // 컨테이너 없음 (초기 / idle stop 이후)
  | 'starting'      // 컨테이너 생성 중
  | 'running'       // 실행 중
  | 'idle_stopped'  // idle timeout 으로 자동 stop (cache 유지)
  | 'error';        // 시작/실행 실패

export type RuntimeProfile =
  | 'node22-python313'  // 기본 — npm, node, python3.13, pip, uv 모두 제공
  | 'operator-tools'    // 운영 workbench — 기본 이미지 + psql/gh 같은 client tools. 권한/secret은 별도 정책.
  | 'python313'         // Python 3.13 전용 (future variant)
  | 'node22'            // Node.js 22 전용 (future variant)
  | 'custom';           // v2+ future (custom image)

// ── Service 상태 ─────────────────────────────────────────────────────────

export type ServiceStatus = 'pending' | 'running' | 'stopped' | 'error' | 'expired';

export type ServiceVisibility =
  | 'private'           // 외부 접근 전혀 없음 (Box 내부에서만)
  | 'project-internal'  // 같은 프로젝트 세션에서 접근 가능
  | 'auth-required'     // Tower 로그인 필요
  | 'unlisted'          // URL 알면 접근 가능 (random slug)
  | 'public';           // 공개 (SEO 허용)

// ── DB Row 타입 ─────────────────────────────────────────────────────────

/** project_runtime_boxes 테이블 행. */
export interface BoxRow {
  id: number;
  project_id: string;
  status: BoxStatus;
  runtime_profile: RuntimeProfile;
  container_id: string | null;
  project_root: string;
  memory_mb: number;
  cpu_limit: string;  // numeric → string from PG
  pids_limit: number;
  disk_quota_mb: number;
  idle_stop_minutes: number;
  last_active_at: string | null;
  started_at: string | null;
  stopped_at: string | null;
  last_error: string | null;
  error_at: string | null;
  created_at: string;
  created_by: number | null;
  updated_at: string;
  secure_mode: string | null;
  network_policy: string | null;
}

/** runtime_box_services 테이블 행. */
export interface ServiceRow {
  id: number;
  box_id: number | null;
  project_id: string;
  runner_kind: 'runtime-box' | 'remote-worker';
  worker_id: string | null;
  name: string;
  display_name: string | null;
  command: string;
  cwd: string;
  internal_port: number | null;
  host_port: number | null;
  external_url: string | null;
  preview_token: string | null;
  status: ServiceStatus;
  visibility: ServiceVisibility;
  process_pid: number | null;
  log_path: string | null;
  pinned: boolean;
  purpose: string | null;
  owner_user_id: number | null;
  ttl_hours: number;
  review_after: string | null;
  started_at: string | null;
  stopped_at: string | null;
  expires_at: string | null;
  last_active_at: string | null;
  created_at: string;
  created_by: number | null;
  last_error: string | null;
}

// ── Exec 요청/결과 ────────────────────────────────────────────────────────

/** 기본 project_shell 단발 실행 timeout. 장기 서버는 service_start 사용. */
export const RUNTIME_BOX_EXEC_TIMEOUT_DEFAULT_SEC = 60;

/** 최대 project_shell 단발 실행 timeout. 긴 빌드/테스트/분석을 위해 15분까지 허용. */
export const RUNTIME_BOX_EXEC_TIMEOUT_MAX_SEC = 15 * 60;

/**
 * project_shell MCP tool → execInBox() 입력.
 * cmd 는 Box 의 /workspace (== 프로젝트 루트) 에서 실행.
 */
export interface ExecRequest {
  boxId: number;
  userId: number;
  sessionId?: string;
  /** 실행할 명령. 예: 'npm install', 'python main.py --flag', 'ls -la'. */
  cmd: string;
  /** 작업 디렉토리. 기본값: '/workspace'. 반드시 /workspace 하위여야 함. */
  cwd?: string;
  /** timeout 초. 기본 60, 최대 900(15분). long-running 은 별도 서비스로 승격. */
  timeout_sec?: number;
  /** 환경 변수 추가. Tower host secrets 주입 금지. */
  env?: Record<string, string>;
  /** Explicit credential policy for internal callers. project_shell omits this and keeps classifier-based suppression. */
  credentialMode?: 'auto' | 'none';
  /** stdout 스트리밍 콜백 (있으면 실시간 전달). */
  onStdout?: (chunk: string) => void;
  /** stderr 스트리밍 콜백. */
  onStderr?: (chunk: string) => void;
  /** Internal process cancellation signal used by durable Workbench Job runners. */
  signal?: AbortSignal;
}

export interface ExecResult {
  exit_code: number;
  stdout: string;    // 최대 1MB
  stderr: string;    // 최대 1MB
  duration_ms: number;
  timed_out: boolean;
  oom_killed: boolean;
  /** 실행된 runtime context 요약 (AI가 로컬과 혼동 방지). */
  runtime_context: RuntimeContext;
}

/**
 * 명령 결과에 첨부되는 실행 context 배너.
 * AI가 host bash / project_shell 을 혼동하지 않도록 도움.
 * 결정: workspace/decisions/2026-06-01-project-runtime-plane-stress-test.md §9.1
 */
export interface RuntimeContext {
  runtime: 'project-runtime-box' | 'workbench-worker';
  /** AI-facing native Workstation contract. Project scope is a default working convention, not a filesystem sandbox. */
  workstation?: {
    shell: 'native';
    persistent_home: boolean;
    host_tools: 'available';
    default_scope: 'current-project';
    guidance: string;
  };
  project_id: string;
  project_name: string;
  cwd: string;
  mount: 'project rw';
  services_running: Array<{ name: string; port: number | null; status: ServiceStatus }>;
  box_limits: {
    memory_mb: number;
    cpu: number;
    idle_stop_minutes: number;
  };
  credential_profiles?: Array<{
    profile_id: string;
    display_name: string;
    env_names: string[];
    secret_env_names: string[];
    file_env_names?: string[];
    skipped_existing: string[];
  }>;
  credential_env?: {
    injected: Array<{ credential_id: string; env_name: string }>;
    materialized_files: Array<{ credential_id: string; env_name: string; kind: 'file'; credential_type?: string }>;
    skipped_existing: Array<{ credential_id: string; env_name: string }>;
    skipped: Array<{ credential_id: string; env_name?: string; reason: string }>;
    suppressed?: boolean;
    suppress_reason?: string;
  };
  readiness?: {
    baseline: 'tower-like-tooling';
    summary: string;
    doctor_command: string;
    capabilities: string[];
    harness_preferred: string[];
  };
}

// ── 서비스 등록 요청 ──────────────────────────────────────────────────────

export interface ServiceRegisterRequest {
  boxId: number;
  projectId: string;
  userId: number;
  /** 서비스 이름. 프로젝트 내 unique. 예: 'dev', 'api'. */
  name: string;
  displayName?: string;
  /** 실행 명령. 예: 'npm run dev', 'uvicorn main:app --host 0.0.0.0 --port 8000'. */
  command: string;
  cwd?: string;
  internalPort?: number;
  visibility?: ServiceVisibility;
  /** pinned=true 면 purpose 필드 강권. */
  pinned?: boolean;
  purpose?: string;
  ttlHours?: number;
}

// ── 명령 분류 ────────────────────────────────────────────────────────────

export type CommandClass =
  | 'light'         // ls, cat, grep, 짧은 스크립트 → 즉시 exec
  | 'heavy'         // npm install, npm test, pytest → heavy job slot 필요
  | 'long-running'  // npm run dev, uvicorn, node server.js → 서비스 승격 권장
  | 'risky';        // curl | bash, chmod +x random → 향후 Secure Run 승격

export interface CommandClassification {
  cls: CommandClass;
  reason: string;
  /** 서비스 승격 권장 시 제안 name (예: 'dev', 'api'). */
  suggested_service_name?: string;
}
