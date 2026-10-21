-- LOCAL CANDIDATE ONLY. No production migration registration or role grants.
CREATE TABLE customer_smoke_budgets (
 instance_id uuid PRIMARY KEY,
 team_observed_microusd bigint NOT NULL CHECK (team_observed_microusd>=0),
 team_observed_at timestamptz NOT NULL,
 smoke_spend_microusd bigint NOT NULL DEFAULT 0 CHECK(smoke_spend_microusd>=0),
 reserved_microusd bigint NOT NULL DEFAULT 0 CHECK(reserved_microusd>=0),
 requests integer NOT NULL DEFAULT 0 CHECK(requests>=0),
 team_limit_microusd bigint NOT NULL DEFAULT 50000000 CHECK(team_limit_microusd=50000000),
 smoke_limit_microusd bigint NOT NULL DEFAULT 1000000 CHECK(smoke_limit_microusd=1000000),
 max_requests integer NOT NULL DEFAULT 5 CHECK(max_requests=5)
);
CREATE TABLE customer_smoke_reservations (
 intent_id uuid PRIMARY KEY REFERENCES customer_service_intents(id),
 instance_id uuid NOT NULL REFERENCES customer_smoke_budgets(instance_id),
 estimated_microusd bigint NOT NULL CHECK(estimated_microusd>0 AND estimated_microusd<=1000000),
 actual_microusd bigint CHECK(actual_microusd>=0),
 request_id text,
 reconciled_at timestamptz,
 CHECK ((reconciled_at IS NULL AND request_id IS NULL AND actual_microusd IS NULL)
 OR (reconciled_at IS NOT NULL AND request_id IS NOT NULL AND actual_microusd IS NOT NULL))
);
REVOKE ALL ON customer_smoke_budgets,customer_smoke_reservations FROM PUBLIC;
