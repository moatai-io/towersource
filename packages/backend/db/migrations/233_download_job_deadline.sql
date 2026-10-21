-- API/Worker enforce the extended deadline only for the exact managed download script.
ALTER TABLE runtime_box_workbench_jobs DROP CONSTRAINT runtime_box_workbench_jobs_timeout_check;
ALTER TABLE runtime_box_workbench_jobs ADD CONSTRAINT runtime_box_workbench_jobs_timeout_check
  CHECK (timeout_seconds IS NULL OR timeout_seconds BETWEEN 1 AND 86400);
