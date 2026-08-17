-- Worker-first service lookup indexes.
-- Kept separate from 176_worker_service_runner.sql so the schema lock is released
-- before PostgreSQL scans runtime_box_services to build indexes.

CREATE INDEX IF NOT EXISTS runtime_box_services_worker_status_idx
  ON runtime_box_services(project_id, worker_id, status)
  WHERE runner_kind = 'remote-worker';

CREATE UNIQUE INDEX IF NOT EXISTS runtime_box_services_worker_name_unique
  ON runtime_box_services(project_id, worker_id, name)
  WHERE runner_kind = 'remote-worker';
