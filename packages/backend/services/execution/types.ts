/** Provider-neutral execution and managed-service contracts. */

export type ServiceStatus = 'pending' | 'running' | 'stopped' | 'error' | 'expired';

export type ServiceVisibility =
  | 'private'
  | 'project-internal'
  | 'auth-required'
  | 'unlisted'
  | 'public';

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

export interface ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  oom_killed: boolean;
  runtime_context: RuntimeContext;
}

export interface RuntimeContext {
  runtime: 'project-runtime-box' | 'workbench-worker';
  workstation?: {
    shell: 'native';
    persistent_home: boolean;
    isolation_profile?: string;
    filesystem_view?: 'native' | 'sandbox';
    host_tools: 'available';
    default_scope: 'current-project';
    guidance: string;
  };
  project_id: string;
  project_name: string;
  cwd: string;
  mount: 'project rw' | 'unverified';
  services_running: Array<{ name: string; port: number | null; status: ServiceStatus }>;
  box_limits: { memory_mb: number; cpu: number; idle_stop_minutes: number };
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

export type CommandClass = 'light' | 'heavy' | 'long-running' | 'risky';

export interface CommandClassification {
  cls: CommandClass;
  reason: string;
  suggested_service_name?: string;
}
