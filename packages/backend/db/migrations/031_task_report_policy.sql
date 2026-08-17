-- ============================================================
-- 031: Task report policy
--
-- Controls how a task's completion is reported:
--   'silent'  — nothing (badge only)
--   'channel' — post to task.room_id
--   'kakao'   — push via messageRouter (Kakao/Telegram)
--   'all'     — both channel and kakao
--   'default' — legacy behaviour (channel if roomId + kakao always)
--
-- New tasks default to 'silent'. Existing tasks are migrated to
-- 'default' so long-running recurring tasks keep delivering the
-- notifications their owners were already receiving.
--
-- See: workspace/decisions/2026-04-22-task-report-policy.md
-- ============================================================

ALTER TABLE tasks
  ADD COLUMN report_policy TEXT NOT NULL DEFAULT 'silent';

-- Preserve existing behaviour for rows that existed before this migration.
UPDATE tasks SET report_policy = 'default';

-- Keep the default 'silent' for rows inserted from now on.
