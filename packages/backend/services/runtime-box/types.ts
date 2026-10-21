/**
 * types.ts — Project Runtime Box v1 공유 타입 정의.
 *
 * Owns: Box / Service / Exec 관련 타입.
 * Public API: BoxStatus, ServiceStatus, RuntimeProfile, BoxRow, ServiceRow,
 *             ExecRequest, ExecResult, ServiceRegisterRequest.
 * See README.md.
 */

export type {
  CommandClass,
  CommandClassification,
  ExecResult,
  RuntimeContext,
  ServiceRow,
  ServiceStatus,
  ServiceVisibility,
} from '../execution/types.js';
import type { ServiceVisibility } from '../execution/types.js';

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
