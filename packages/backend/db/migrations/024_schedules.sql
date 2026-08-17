-- Unified Schedule — 스케줄 통합 시스템
-- spawn(태스크), inject(세션 주입), channel(채널 게시) 세 가지 모드를 하나의 테이블로 관리

CREATE TABLE IF NOT EXISTS schedules (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  project_id      TEXT,

  -- 무엇을
  name            TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  model           TEXT DEFAULT 'claude-sonnet-4-6',

  -- 어떻게 (실행 모드)
  mode            TEXT NOT NULL DEFAULT 'spawn',  -- 'spawn' | 'inject' | 'channel'
  target_id       TEXT,                           -- session_id (inject) | room_id (channel) | null (spawn)

  -- 언제 (트리거)
  trigger_type    TEXT NOT NULL DEFAULT 'cron',   -- 'cron' | 'once'
  cron_config     JSONB,                          -- { type, hour, minute, day, hours }
  once_at         TIMESTAMPTZ,                    -- one-time execution time

  -- 스케줄 상태
  enabled         BOOLEAN NOT NULL DEFAULT true,
  next_run_at     TIMESTAMPTZ,
  last_run_at     TIMESTAMPTZ,
  run_count       INTEGER NOT NULL DEFAULT 0,
  last_status     TEXT,                           -- 'success' | 'failed' | 'skipped'
  last_error      TEXT,

  -- 메타
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at)
  WHERE enabled = true;

CREATE INDEX IF NOT EXISTS idx_schedules_user ON schedules(user_id);

-- 실행 로그
CREATE TABLE IF NOT EXISTS schedule_runs (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  schedule_id     TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,                  -- 'success' | 'failed' | 'skipped'
  mode            TEXT NOT NULL,                  -- snapshot of mode at run time
  result_id       TEXT,                           -- task_id | session_id | message_id
  error           TEXT,
  duration_ms     INTEGER,
  ran_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule ON schedule_runs(schedule_id, ran_at DESC);

-- Migrate existing scheduled tasks to schedules table
INSERT INTO schedules (user_id, project_id, name, prompt, model, mode, trigger_type, cron_config, once_at, next_run_at, enabled)
SELECT
  COALESCE(user_id, 1),
  project_id,
  title,
  COALESCE(description, title),
  COALESCE(model, 'claude-opus-4-6'),
  'spawn',
  CASE WHEN schedule_cron IS NOT NULL THEN 'cron' ELSE 'once' END,
  CASE WHEN schedule_cron IS NOT NULL THEN schedule_cron::jsonb ELSE NULL END,
  CASE WHEN schedule_cron IS NULL THEN scheduled_at::timestamptz ELSE NULL END,
  scheduled_at::timestamptz,
  (schedule_enabled = 1)
FROM tasks
WHERE (schedule_enabled = 1 OR scheduled_at IS NOT NULL)
  AND (archived IS NULL OR archived = 0)
  AND scheduled_at IS NOT NULL;
