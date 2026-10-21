-- Customer native standard application role. Operator-reviewed installation only.
-- Prerequisite: postgres-owned candidate schema and locked-approval functions.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tower' AND NOT rolsuper AND NOT rolbypassrls) THEN RAISE EXCEPTION 'customer_application_role_invalid'; END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles r ON c.relowner=r.oid WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('customer_runtime_approvals','customer_service_intents','customer_delivery_intents','customer_smoke_budgets','customer_smoke_reservations') AND r.rolname<>'postgres') THEN RAISE EXCEPTION 'customer_policy_owner_invalid'; END IF;
END $$;
REVOKE ALL ON customer_runtime_approvals,customer_service_intents,customer_delivery_intents,customer_smoke_budgets,customer_smoke_reservations FROM tower;
GRANT SELECT ON customer_runtime_approvals,customer_service_intents,customer_delivery_intents,customer_smoke_budgets,customer_smoke_reservations TO tower;
GRANT UPDATE(consumed_at) ON customer_service_intents,customer_delivery_intents TO tower;
GRANT UPDATE(team_observed_microusd,team_observed_at,reserved_microusd,requests,smoke_spend_microusd) ON customer_smoke_budgets TO tower;
GRANT INSERT ON customer_smoke_reservations TO tower;
GRANT UPDATE(actual_microusd,request_id,reconciled_at) ON customer_smoke_reservations TO tower;
GRANT EXECUTE ON FUNCTION public.lock_customer_runtime_approval(text,text,uuid,uuid,bigint,text),public.lock_customer_smoke_intent(uuid,uuid,text) TO tower;
COMMIT;
