import type {CustomerIntentClient} from './pg-intent-store.js';
import type {CustomerRuntimeBinding,CustomerServiceRequest} from './service-boundary.js';
/** Locks approved policy and local active admin/Project rows before consuming a provider/paid-request intent. */
export async function assertLockedCustomerAuthority(c:CustomerIntentClient,input:CustomerServiceRequest & {binding:CustomerRuntimeBinding}){
 const approval=await c.query(`SELECT public.lock_customer_runtime_approval($1::text,$2::text,$3::uuid,$4::uuid,$5::bigint,$6::text) AS approval_hash`,
 [input.approvalHash,input.customerId,input.instanceId,input.binding.projectId,input.binding.actorUserId,input.operation]);
 if(input.operation.startsWith('smoke-')){const model=input.model??input.binding.smokeModel;if(!model||model!==input.binding.smokeModel)throw Error('customer_locked_smoke_model_denied');const r=await c.query('SELECT public.lock_customer_smoke_model($1::text,$2::uuid,$3::text) AS model',[input.approvalHash,input.instanceId,model]);if(r.rowCount!==1)throw Error('customer_locked_smoke_model_denied');}
 if(approval.rowCount!==1)throw Error('customer_locked_approval_denied');
 // Workspace credential administration requires a fresh active admin; no role elevation or actor creation.
 const actor=await c.query(`SELECT id FROM users WHERE id=$1 AND role='admin' AND disabled=0
  AND COALESCE(approval_status,'active')='active' FOR SHARE`,[input.binding.actorUserId]);
 if(actor.rowCount!==1)throw Error('customer_locked_actor_denied');
 const project=await c.query('SELECT id FROM projects WHERE id=$1 FOR SHARE',[input.binding.projectId]);
 if(project.rowCount!==1)throw Error('customer_locked_project_denied');
}
