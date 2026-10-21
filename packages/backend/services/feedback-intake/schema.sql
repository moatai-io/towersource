-- Manual, central-only activation. NOT an auto-scanned Tower migration.
-- Apply only after separate operator approval, backup, and schema review.
BEGIN;
CREATE TABLE IF NOT EXISTS feedback_tenants (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  title_prefix text NOT NULL CHECK (title_prefix ~ '^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$'),
  label text NOT NULL CHECK (label ~ '^customer:[a-z0-9][a-z0-9-]{0,62}$'),
  active boolean NOT NULL DEFAULT true,
  rate_window timestamptz NOT NULL DEFAULT now(),
  rate_count integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS feedback_receipts (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES feedback_tenants(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  reporter_user_id bigint NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','delivering','delivered','needs_review','failed')),
  attempts integer NOT NULL DEFAULT 0,
  claim_id uuid,
  claim_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  issue_number bigint,
  issue_url text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS feedback_delivery_queue ON feedback_receipts(next_attempt_at, created_at) WHERE status = 'accepted';
CREATE INDEX IF NOT EXISTS feedback_expired_claims ON feedback_receipts(claim_until) WHERE status = 'delivering';
COMMIT;
