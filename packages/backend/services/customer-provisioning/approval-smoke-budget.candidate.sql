-- Additive approval-specific budget. Historical reservations remain untouched.
CREATE TABLE customer_smoke_approval_budgets (
 approval_hash text PRIMARY KEY REFERENCES customer_runtime_approvals(approval_hash),
 instance_id uuid NOT NULL REFERENCES customer_smoke_budgets(instance_id),
 limit_microusd bigint NOT NULL CHECK(limit_microusd>0 AND limit_microusd<=3000000),
 max_requests integer NOT NULL CHECK(max_requests>0 AND max_requests<=3),
 reserved_microusd bigint NOT NULL DEFAULT 0 CHECK(reserved_microusd>=0),
 spent_microusd bigint NOT NULL DEFAULT 0 CHECK(spent_microusd>=0),
 requests integer NOT NULL DEFAULT 0 CHECK(requests>=0),
 CHECK(reserved_microusd+spent_microusd<=limit_microusd),
 CHECK(requests<=max_requests)
);
CREATE TABLE customer_smoke_approval_reservations (
 intent_id uuid PRIMARY KEY REFERENCES customer_smoke_reservations(intent_id),
 approval_hash text NOT NULL REFERENCES customer_smoke_approval_budgets(approval_hash)
);
REVOKE ALL ON customer_smoke_approval_budgets,customer_smoke_approval_reservations FROM PUBLIC;
GRANT SELECT ON customer_smoke_approval_budgets,customer_smoke_approval_reservations TO tower;
GRANT UPDATE(reserved_microusd,spent_microusd,requests) ON customer_smoke_approval_budgets TO tower;
GRANT INSERT ON customer_smoke_approval_reservations TO tower;

CREATE TABLE customer_smoke_response_evidence (
 intent_id uuid PRIMARY KEY REFERENCES customer_smoke_approval_reservations(intent_id),
 approval_hash text NOT NULL REFERENCES customer_smoke_approval_budgets(approval_hash),
 request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 2048 AND request_id ~ '^[-A-Za-z0-9_:./=+]+$'),
 model text NOT NULL CHECK(model='gpt-6.1-sol'),
 sentinel text NOT NULL CHECK(sentinel='TOWER_SMOKE_OK'),
 recorded_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON customer_smoke_response_evidence FROM PUBLIC;
GRANT SELECT,INSERT ON customer_smoke_response_evidence TO tower;
