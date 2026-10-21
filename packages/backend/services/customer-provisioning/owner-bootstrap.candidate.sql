-- Review-only customer Tower schema. Never automatically applied by startup.
-- Publication and grants require a separate reviewed operator identity.
BEGIN;
CREATE TABLE IF NOT EXISTS customer_owner_bootstrap_approvals (
 approval_hash text PRIMARY KEY CHECK (approval_hash ~ '^[a-f0-9]{64}$'),
 approval jsonb NOT NULL CHECK (jsonb_typeof(approval)='object'),
 expires_at timestamptz NOT NULL,
 revoked boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT NOW(),
 CHECK (approval ?& ARRAY['issuer','customerId','instanceId','approvalHash','creationCommandId','projectName','identity']),
 CHECK (approval->>'approvalHash'=approval_hash),
 CHECK (jsonb_typeof(approval->'identity')='object'),
 CHECK ((approval->'identity'->>'role' IN ('owner','admin')) IS TRUE)
);
REVOKE ALL ON customer_owner_bootstrap_approvals FROM PUBLIC;
-- No runtime role grant here. Runtime should receive SELECT only; it must not publish approval.
-- Installation/revocation serialization remains mandatory; this table alone is not a write fence.
COMMIT;
