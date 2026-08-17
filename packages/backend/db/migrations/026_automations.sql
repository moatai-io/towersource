-- Automations — Tasks + Schedules 통합
-- 수동 실행(manual), 크론(cron), 일회(once) 트리거를 하나의 엔티티로 관리

CREATE TABLE IF NOT EXISTS automations (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  project_id      TEXT,

  -- 기본 정보
  name            TEXT NOT NULL,
  description     TEXT DEFAULT '',
  prompt          TEXT NOT NULL DEFAULT '',
  model           TEXT DEFAULT 'claude-sonnet-4-6',
  workflow        TEXT DEFAULT 'auto',

  -- 실행 모드
  mode            TEXT NOT NULL DEFAULT 'spawn',   -- 'spawn' | 'inject' | 'channel'
  target_id       TEXT,                            -- inject: session_id, channel: room_id
  cwd             TEXT,                            -- spawn 모드용 작업 디렉토리

  -- 트리거
  trigger_type    TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'cron' | 'once'
  cron_config     JSONB,                           -- { type, hour, minute, day, hours }
  once_at         TIMESTAMPTZ,

  -- 상태
  status          TEXT NOT NULL DEFAULT 'idle',    -- 'idle' | 'running' | 'done' | 'failed' | 'archived'
  enabled         BOOLEAN NOT NULL DEFAULT true,
  sort_order      INTEGER DEFAULT 0,

  -- 실행 추적
  session_id      TEXT,                            -- 현재/마지막 실행 세션
  next_run_at     TIMESTAMPTZ,
  last_run_at     TIMESTAMPTZ,
  run_count       INTEGER NOT NULL DEFAULT 0,
  last_status     TEXT,
  last_error      TEXT,

  -- 태스크 메타 (칸반 지원)
  progress_summary TEXT DEFAULT '[]',
  todo_snapshot   TEXT,
  parent_id       TEXT,
  worktree_path   TEXT,

  -- 채널 연동
  room_id         TEXT,
  triggered_by    INTEGER,
  room_message_id TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_automations_user ON automations(user_id);
CREATE INDEX IF NOT EXISTS idx_automations_project ON automations(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automations_status ON automations(status) WHERE status NOT IN ('archived');
CREATE INDEX IF NOT EXISTS idx_automations_due ON automations(next_run_at)
  WHERE enabled = true AND trigger_type IN ('cron', 'once') AND next_run_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automations_running ON automations(status) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_automations_parent ON automations(parent_id) WHERE parent_id IS NOT NULL;

-- 실행 이력
CREATE TABLE IF NOT EXISTS automation_runs (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  automation_id   TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,          -- 'success' | 'failed' | 'aborted'
  mode            TEXT NOT NULL,
  result_id       TEXT,                   -- session_id or message_id
  error           TEXT,
  duration_ms     INTEGER,
  ran_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_automation ON automation_runs(automation_id, ran_at DESC);

-- ── 데이터 마이그레이션: tasks → automations ──

INSERT INTO automations (
  id, user_id, project_id,
  name, description, prompt, model, workflow,
  mode, cwd,
  trigger_type, cron_config, once_at,
  status, enabled, sort_order,
  session_id, next_run_at, last_run_at, run_count,
  progress_summary, todo_snapshot, parent_id, worktree_path,
  room_id, triggered_by, room_message_id,
  created_at, updated_at, completed_at
)
SELECT
  id, COALESCE(user_id, 1), project_id,
  title, COALESCE(description, ''), COALESCE(description, title), COALESCE(model, 'claude-opus-4-6'), COALESCE(workflow, 'auto'),
  'spawn', cwd,
  CASE
    WHEN schedule_enabled = 1 AND schedule_cron IS NOT NULL THEN 'cron'
    WHEN scheduled_at IS NOT NULL THEN 'once'
    ELSE 'manual'
  END,
  CASE WHEN schedule_cron IS NOT NULL THEN schedule_cron::jsonb ELSE NULL END,
  CASE WHEN schedule_cron IS NULL THEN scheduled_at::timestamptz ELSE NULL END,
  CASE status
    WHEN 'todo' THEN 'idle'
    WHEN 'in_progress' THEN 'running'
    WHEN 'done' THEN 'done'
    WHEN 'failed' THEN 'failed'
    ELSE 'idle'
  END,
  CASE WHEN schedule_enabled = 1 THEN true ELSE true END,
  sort_order,
  session_id, scheduled_at::timestamptz, NULL, 0,
  COALESCE(progress_summary, '[]'), todo_snapshot, parent_task_id, worktree_path,
  room_id, triggered_by, room_message_id,
  created_at, updated_at, completed_at
FROM tasks
WHERE (archived IS NULL OR archived = 0);

-- ── 데이터 마이그레이션: schedules → automations (중복 방지) ──

INSERT INTO automations (
  id, user_id, project_id,
  name, description, prompt, model,
  mode, target_id,
  trigger_type, cron_config, once_at,
  status, enabled,
  next_run_at, last_run_at, run_count, last_status, last_error,
  created_at, updated_at
)
SELECT
  s.id, s.user_id, s.project_id,
  s.name, '', s.prompt, s.model,
  s.mode, s.target_id,
  s.trigger_type, s.cron_config, s.once_at,
  CASE WHEN s.enabled THEN 'idle' ELSE 'idle' END, s.enabled,
  s.next_run_at, s.last_run_at, s.run_count, s.last_status, s.last_error,
  s.created_at, s.updated_at
FROM schedules s
WHERE s.id NOT IN (SELECT id FROM automations);

-- schedule_runs → automation_runs
INSERT INTO automation_runs (id, automation_id, status, mode, result_id, error, duration_ms, ran_at)
SELECT id, schedule_id, status, mode, result_id, error, duration_ms, ran_at
FROM schedule_runs
WHERE schedule_id IN (SELECT id FROM automations);
