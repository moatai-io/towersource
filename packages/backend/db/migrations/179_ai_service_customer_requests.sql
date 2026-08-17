-- 179: Customer-request CTA submissions for public AI Service conversations.
-- Delivery is an audited state machine; a submission is never reported as emailed until an adapter confirms it.

CREATE TABLE IF NOT EXISTS ai_service_customer_requests (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  service_id TEXT NOT NULL REFERENCES ai_services(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL REFERENCES ai_service_deployments(id) ON DELETE RESTRICT,
  channel_id TEXT NOT NULL REFERENCES ai_service_channels(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES ai_service_conversations(id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  action_label TEXT NOT NULL,
  destination_type TEXT NOT NULL CHECK (destination_type IN ('email')),
  destination_ref TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  user_key TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  contact JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','delivery_pending','delivered','delivery_failed','cancelled')),
  delivery_reference TEXT,
  delivery_error TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  UNIQUE(channel_id, conversation_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ai_service_customer_requests_service_created
  ON ai_service_customer_requests(service_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_service_customer_requests_delivery
  ON ai_service_customer_requests(status, created_at)
  WHERE status IN ('recorded','delivery_pending','delivery_failed');
