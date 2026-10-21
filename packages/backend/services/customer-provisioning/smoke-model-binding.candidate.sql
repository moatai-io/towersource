-- REVIEW ONLY. Explicit operator installation + NEW approval required.
-- Old approval has NULL model and cannot authorize any smoke. No backfill/default.
BEGIN;
ALTER TABLE public.customer_runtime_approvals ADD COLUMN smoke_model text
 CHECK(smoke_model IS NULL OR smoke_model IN ('gpt-6.1-sol','~deepseek/deepseek-pro-latest'));
CREATE FUNCTION public.lock_customer_smoke_model(p_hash text,p_instance uuid,p_model text)
RETURNS SETOF text LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT smoke_model FROM public.customer_runtime_approvals
 WHERE approval_hash=p_hash AND instance_id=p_instance AND revoked=false
 AND expires_at>clock_timestamp() AND smoke_model=p_model
 AND smoke_model IN ('gpt-6.1-sol','~deepseek/deepseek-pro-latest')
 FOR SHARE
$$;
REVOKE ALL ON FUNCTION public.lock_customer_smoke_model(text,uuid,text) FROM PUBLIC;
-- Existing explicit installer verifies application role; this candidate is not startup DDL.
GRANT EXECUTE ON FUNCTION public.lock_customer_smoke_model(text,uuid,text) TO tower;
CREATE FUNCTION public.guard_customer_smoke_model_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.smoke_model IS DISTINCT FROM OLD.smoke_model THEN RAISE EXCEPTION 'customer_smoke_model_immutable_new_approval_required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER customer_smoke_model_immutable BEFORE UPDATE ON public.customer_runtime_approvals
 FOR EACH ROW EXECUTE FUNCTION public.guard_customer_smoke_model_immutable();
ALTER TABLE public.customer_smoke_response_evidence DROP CONSTRAINT customer_smoke_response_evidence_model_check;
ALTER TABLE public.customer_smoke_response_evidence ADD CONSTRAINT customer_smoke_response_evidence_model_check
 CHECK(model IN ('gpt-6.1-sol','~deepseek/deepseek-pro-latest'));
-- Existing reservation fences and intent uniqueness,
-- held reservation and spend reconciliation remain unchanged.
COMMIT;
