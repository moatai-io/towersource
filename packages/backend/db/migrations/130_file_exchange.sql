-- 130: Server-authored plans and durable receipts for cross-scope file delivery.
CREATE TABLE IF NOT EXISTS file_exchange_plans (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_ref            JSONB NOT NULL,
  destination_ref       JSONB NOT NULL,
  mode                  TEXT NOT NULL CHECK (mode IN ('snapshot', 'workspace_copy')),
  source_name           TEXT NOT NULL,
  source_mime_type      TEXT,
  source_size_bytes     BIGINT NOT NULL,
  source_version        TEXT NOT NULL,
  source_sha256         TEXT NOT NULL,
  confirmation_required BOOLEAN NOT NULL DEFAULT FALSE,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'executing', 'completed', 'failed', 'expired')),
  expires_at            TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_file_exchange_plans_actor_time
  ON file_exchange_plans(actor_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS file_exchange_receipts (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  plan_id               UUID NOT NULL UNIQUE REFERENCES file_exchange_plans(id) ON DELETE CASCADE,
  actor_user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_ref            JSONB NOT NULL,
  destination_ref       JSONB NOT NULL,
  result_ref            JSONB,
  mode                  TEXT NOT NULL CHECK (mode IN ('snapshot', 'workspace_copy')),
  status                TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'denied', 'stale')),
  confirmation_recorded BOOLEAN NOT NULL DEFAULT FALSE,
  source_sha256         TEXT NOT NULL,
  failure_code          TEXT,
  failure_stage         TEXT,
  orphan_detail         JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_file_exchange_receipts_actor_time
  ON file_exchange_receipts(actor_user_id, created_at DESC);

COMMENT ON TABLE file_exchange_plans IS
  'Short-lived server-authored plans for cross-scope file delivery; clients cannot assert ACL or host paths.';
COMMENT ON TABLE file_exchange_receipts IS
  'Durable result records for completed, denied, stale, and compensated File Exchange executions.';
