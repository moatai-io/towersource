-- LOCAL CANDIDATE ONLY. Not registered with Tower migrations or applied operationally.
CREATE TABLE customer_runtime_approvals (
 approval_hash text PRIMARY KEY CHECK (approval_hash ~ '^[a-f0-9]{64}$'),
 customer_id text NOT NULL,
 instance_id uuid NOT NULL,
 project_id uuid NOT NULL,
 actor_user_id bigint NOT NULL CHECK (actor_user_id > 0),
 operations text[] NOT NULL,
 expires_at timestamptz NOT NULL,
 revoked boolean NOT NULL DEFAULT false
);
REVOKE ALL ON customer_runtime_approvals FROM PUBLIC;
CREATE TABLE customer_service_intents (
 id uuid PRIMARY KEY,
 customer_id text NOT NULL,
 instance_id uuid NOT NULL,
 approval_hash text NOT NULL REFERENCES customer_runtime_approvals(approval_hash),
 operation text NOT NULL CHECK (operation IN ('enrollment-issue','smoke-execute')),
 provider_kind text CHECK (provider_kind IN ('zuplo','litellm')),
 project_id uuid NOT NULL,
 actor_user_id bigint NOT NULL CHECK (actor_user_id > 0),
 expires_at timestamptz NOT NULL,
 revoked boolean NOT NULL DEFAULT false,
 consumed_at timestamptz,
 CHECK ((operation='enrollment-issue' AND provider_kind IS NOT NULL) OR (operation='smoke-execute' AND provider_kind IS NULL))
);
REVOKE ALL ON customer_service_intents FROM PUBLIC;
-- No service grants here: publishing and consumption roles require a separate reviewed ACL design.

-- Separate delivery stage: request consumption must precede this stage.
-- Must be published alongside its customer_service_intents row; never auto-created by receiver.
CREATE TABLE customer_delivery_intents (
 id uuid PRIMARY KEY REFERENCES customer_service_intents(id),
 policy_hash text NOT NULL CHECK(policy_hash ~ '^[a-f0-9]{64}$'),
 credential_id text NOT NULL,
 consumed_at timestamptz
);
REVOKE ALL ON customer_delivery_intents FROM PUBLIC;
