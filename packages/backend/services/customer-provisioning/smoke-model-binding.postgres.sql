-- Isolated fixture only. Never publish production approval.
DO $$
DECLARE instance uuid:='11111111-1111-4111-8111-111111111111'; project uuid:='22222222-2222-4222-8222-222222222222'; result text;
BEGIN
 INSERT INTO customer_runtime_approvals(approval_hash,customer_id,instance_id,project_id,actor_user_id,operations,expires_at,smoke_model)
 VALUES(repeat('a',64),'fixture',instance,project,1,ARRAY['smoke-execute'],clock_timestamp()+interval '1 hour','gpt-6.1-sol'),
 (repeat('b',64),'fixture',instance,project,1,ARRAY['smoke-execute'],clock_timestamp()+interval '1 hour','~deepseek/deepseek-pro-latest'),
 (repeat('c',64),'fixture',instance,project,1,ARRAY['smoke-execute'],clock_timestamp()+interval '1 hour',NULL);
 SELECT * INTO result FROM lock_customer_smoke_model(repeat('b',64),instance,'~deepseek/deepseek-pro-latest');
 IF result IS DISTINCT FROM '~deepseek/deepseek-pro-latest' THEN RAISE EXCEPTION 'deepseek_failed';END IF;
 IF EXISTS(SELECT 1 FROM lock_customer_smoke_model(repeat('b',64),instance,'gpt-6.1-sol')) THEN RAISE EXCEPTION 'fallback_allowed';END IF;
 IF EXISTS(SELECT 1 FROM lock_customer_smoke_model(repeat('c',64),instance,'gpt-6.1-sol')) THEN RAISE EXCEPTION 'old_authority_promoted';END IF;
 BEGIN UPDATE customer_runtime_approvals SET smoke_model='gpt-6.1-sol' WHERE approval_hash=repeat('c',64);RAISE EXCEPTION 'model_updated';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM='model_updated' THEN RAISE;END IF;END;
 UPDATE customer_runtime_approvals SET revoked=true WHERE approval_hash=repeat('b',64);
 IF EXISTS(SELECT 1 FROM lock_customer_smoke_model(repeat('b',64),instance,'~deepseek/deepseek-pro-latest')) THEN RAISE EXCEPTION 'revoked_allowed';END IF;
END $$;
SET ROLE tower;
SELECT * FROM public.lock_customer_smoke_model(repeat('a',64),'11111111-1111-4111-8111-111111111111','gpt-6.1-sol');
DO $$ BEGIN
 BEGIN UPDATE customer_runtime_approvals SET smoke_model='gpt-6.1-sol';RAISE EXCEPTION 'app_can_write';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END $$;
