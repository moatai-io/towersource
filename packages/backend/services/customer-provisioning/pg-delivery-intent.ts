import type {CustomerIntentPool} from './pg-intent-store.js';
import type {ApprovedDelivery} from './central-delivery.js';
import type {CustomerRuntimeBinding} from './service-boundary.js';
import {assertLockedCustomerAuthority} from './pg-locked-authority.js';
/** Delivery consumes its own row AFTER the enrollment row was consumed. No retry on uncertain commit. */
export async function consumeCustomerDeliveryIntent(pool:CustomerIntentPool,d:ApprovedDelivery,binding:CustomerRuntimeBinding){
 const c=await pool.connect();let committed=false;
 try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
  await assertLockedCustomerAuthority(c,{...d,operation:'enrollment-issue',binding});
  const r=await c.query(`UPDATE customer_delivery_intents v SET consumed_at=clock_timestamp()
   WHERE v.id=$1::uuid AND v.policy_hash=$2 AND v.credential_id=$3 AND v.consumed_at IS NULL
   AND EXISTS(SELECT 1 FROM customer_service_intents i WHERE i.id=v.id AND i.customer_id=$4 AND i.instance_id=$5::uuid
   AND i.approval_hash=$6 AND i.provider_kind=$7 AND i.operation='enrollment-issue' AND i.project_id=$8::uuid AND i.actor_user_id=$9
   AND i.revoked=false AND i.expires_at>clock_timestamp() AND i.consumed_at IS NOT NULL)
   RETURNING v.id`,[d.intentId,d.policyHash,d.credentialId,d.customerId,d.instanceId,d.approvalHash,d.providerKind,binding.projectId,binding.actorUserId]);
  if(r.rowCount!==1)throw Error('customer_delivery_intent_denied');
  await c.query('COMMIT');committed=true;
 }catch{throw Error('customer_delivery_intent_denied_or_unknown_no_replay');}
 finally{if(!committed)try{await c.query('ROLLBACK');}catch{}c.release();}
}
