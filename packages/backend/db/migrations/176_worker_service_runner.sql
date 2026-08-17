-- Worker-first service runner metadata.
-- Existing Runtime Box services keep runner_kind='runtime-box' and box_id populated.
-- Worker services set runner_kind='remote-worker', worker_id populated, and box_id NULL.
-- Indexes are created separately in 180_worker_service_runner_indexes.sql so this
-- lock-sensitive schema migration commits before index construction begins.

ALTER TABLE runtime_box_services
  ADD COLUMN IF NOT EXISTS runner_kind TEXT NOT NULL DEFAULT 'runtime-box',
  ADD COLUMN IF NOT EXISTS worker_id TEXT;

ALTER TABLE runtime_box_services
  ALTER COLUMN box_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'runtime_box_services_runner_kind_chk'
  ) THEN
    ALTER TABLE runtime_box_services
      ADD CONSTRAINT runtime_box_services_runner_kind_chk
      CHECK (runner_kind IN ('runtime-box', 'remote-worker'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'runtime_box_services_runner_target_chk'
  ) THEN
    ALTER TABLE runtime_box_services
      ADD CONSTRAINT runtime_box_services_runner_target_chk
      CHECK (
        (runner_kind = 'runtime-box' AND box_id IS NOT NULL AND worker_id IS NULL)
        OR
        (runner_kind = 'remote-worker' AND box_id IS NULL AND worker_id IS NOT NULL)
      );
  END IF;
END $$;
