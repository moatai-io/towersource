-- Personal acknowledgement of a Run is not its execution outcome or an alert.
CREATE TABLE IF NOT EXISTS automation_result_receipts (
  run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ,
  actioned_at TIMESTAMPTZ,
  PRIMARY KEY (run_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_automation_result_receipts_user
  ON automation_result_receipts(user_id, run_id);
