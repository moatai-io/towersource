-- Operator-installed, not startup migration. Application cannot modify approvals.
BEGIN;
CREATE FUNCTION public.lock_customer_runtime_approval(p_hash text,p_customer text,p_instance uuid,p_project uuid,p_actor bigint,p_operation text)
RETURNS SETOF text LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT approval_hash FROM public.customer_runtime_approvals
 WHERE approval_hash=p_hash AND customer_id=p_customer AND instance_id=p_instance AND project_id=p_project AND actor_user_id=p_actor
 AND revoked=false AND expires_at>clock_timestamp() AND p_operation=ANY(operations) FOR SHARE
$$;
REVOKE ALL ON FUNCTION public.lock_customer_runtime_approval(text,text,uuid,uuid,bigint,text) FROM PUBLIC;
-- Grant EXECUTE only to the verified customer application role at installation.
CREATE FUNCTION public.lock_customer_smoke_intent(p_intent uuid,p_instance uuid,p_hash text)
RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT i.id FROM public.customer_service_intents i JOIN public.customer_runtime_approvals a ON a.approval_hash=i.approval_hash
 WHERE i.id=p_intent AND i.instance_id=p_instance AND i.approval_hash=p_hash AND i.operation='smoke-execute' AND i.consumed_at IS NOT NULL
 AND i.revoked=false AND i.expires_at>clock_timestamp() AND a.revoked=false AND a.expires_at>clock_timestamp()
 AND a.instance_id=i.instance_id AND a.customer_id=i.customer_id AND a.project_id=i.project_id AND a.actor_user_id=i.actor_user_id
 AND 'smoke-execute'=ANY(a.operations) FOR SHARE OF a,i
$$;
REVOKE ALL ON FUNCTION public.lock_customer_smoke_intent(uuid,uuid,text) FROM PUBLIC;
COMMIT;
