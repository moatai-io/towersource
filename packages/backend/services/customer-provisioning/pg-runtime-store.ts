import {queryOne} from '../../db/pg-repo.js';
import {getPgPool} from '../../db/pg.js';
import {assertCustomerLocalVaultAccess} from './local-vault-access.js';
import {consumeCustomerIntent} from './pg-intent-store.js';
import {assertLockedCustomerAuthority} from './pg-locked-authority.js';
import type {ApprovedCustomerRuntime,CustomerRuntimeAuthorityStore} from './runtime-authority.js';
/** Explicitly selected store; schema and approval publication remain separately approved operations. */
export function pgCustomerRuntimeStore(localInstanceId:()=>Promise<string>,approvalHash:string):CustomerRuntimeAuthorityStore{
 if(!/^[a-f0-9]{64}$/.test(approvalHash))throw Error('customer_runtime_store_config_invalid');
 return {
  localInstanceId,
  async approvedRuntime(){
   const x=await queryOne<{customer_id:string;instance_id:string;project_id:string;actor_user_id:string|number;approval_hash:string;expires_at:Date|string;revoked:boolean;operations:ApprovedCustomerRuntime['operations'];smoke_model:string|null}>(
    'SELECT customer_id,instance_id,project_id,actor_user_id,approval_hash,expires_at,revoked,operations,smoke_model FROM customer_runtime_approvals WHERE approval_hash=$1',[approvalHash]);
   if(!x)throw Error('customer_runtime_approval_missing');
   return {customerId:x.customer_id,instanceId:x.instance_id,projectId:x.project_id,actorUserId:Number(x.actor_user_id),approvalHash:x.approval_hash,expiresAt:new Date(x.expires_at).toISOString(),revoked:x.revoked,operations:x.operations,...(x.smoke_model?{smokeModel:x.smoke_model}:{})};
  },
  assertLocalAccess:assertCustomerLocalVaultAccess,
  async consumeApprovedIntent(input){await consumeCustomerIntent(getPgPool(),input,assertLockedCustomerAuthority);},
 };
}
