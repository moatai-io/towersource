-- Gateway Customers — managed service API key management
-- Only used on TOWER_ROLE=full servers (Central Publish Gateway)

CREATE TABLE IF NOT EXISTS gateway_customers (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  customer_name TEXT NOT NULL UNIQUE,           -- e.g. 'demo-org'
  api_key       TEXT NOT NULL UNIQUE,           -- e.g. 'cust_demo-org_xxxx'
  profile       TEXT NOT NULL DEFAULT 'basic',  -- 'basic' | 'full'
  quota_sites   INT NOT NULL DEFAULT 10,
  quota_apps    INT NOT NULL DEFAULT 5,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  metadata      JSONB DEFAULT '{}',             -- extra config per customer
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gateway_customers_api_key ON gateway_customers(api_key);
CREATE INDEX IF NOT EXISTS idx_gateway_customers_active ON gateway_customers(is_active) WHERE is_active = true;

-- Deploy log — tracks every deployment made through the gateway
CREATE TABLE IF NOT EXISTS gateway_deploy_log (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  customer_id   TEXT NOT NULL REFERENCES gateway_customers(id) ON DELETE CASCADE,
  deploy_name   TEXT NOT NULL,           -- project/app name
  deploy_type   TEXT NOT NULL,           -- 'static' | 'dynamic'
  deploy_target TEXT NOT NULL,           -- 'cloudflare-pages' | 'azure-container-apps'
  result_url    TEXT,
  success       BOOLEAN NOT NULL,
  error         TEXT,
  duration_ms   INT,
  file_size     BIGINT,                  -- uploaded tar.gz size in bytes
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gateway_deploy_log_customer ON gateway_deploy_log(customer_id);
CREATE INDEX IF NOT EXISTS idx_gateway_deploy_log_created ON gateway_deploy_log(created_at DESC);
