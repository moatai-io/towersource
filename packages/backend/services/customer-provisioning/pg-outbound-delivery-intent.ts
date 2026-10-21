import type {CustomerIntentPool} from './pg-intent-store.js';import type {ApprovedDelivery} from './central-delivery.js';import type {CustomerRuntimeBinding} from './service-boundary.js';import {assertLockedCustomerAuthority} from './pg-locked-authority.js';
/** Outbound has no earlier inbound issue request. Consume both preapproved local stages
 * atomically before Vault store, without synthesizing approvals or altering push behavior.
 */
export async function consumeOutboundDeliveryIntent(pool:CustomerIntentPool,d:ApprovedDelivery,b:CustomerRuntimeBinding){
 const c=await pool.connect();let committed=false;
 try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");await assertLockedCustomerAuthority(c,{...d,operation:'enrollment-issue',binding:b});
  const rows=await c.query(`SELECT i.id FROM customer_service_intents i JOIN customer_delivery_intents v ON v.id=i.id
   WHERE i.id=$1::uuid AND i.customer_id=$2 AND i.instance_id=$3::uuid AND i.approval_hash=$4 AND i.operation='enrollment-issue'
   AND i.provider_kind=$5 AND i.project_id=$6::uuid AND i.actor_user_id=$7 AND i.revoked=false AND i.expires_at>clock_timestamp()
   AND i.consumed_at IS NULL AND v.consumed_at IS NULL AND v.credential_id=$8 AND v.policy_hash=$9 FOR UPDATE OF i,v`,[d.intentId,d.customerId,d.instanceId,d.approvalHash,d.providerKind,b.projectId,b.actorUserId,d.credentialId,d.policyHash]);
  if(rows.rowCount!==1)throw Error('outbound_local_intent_unavailable');
  await c.query('UPDATE customer_service_intents SET consumed_at=clock_timestamp() WHERE id=$1::uuid',[d.intentId]);
  await c.query('UPDATE customer_delivery_intents SET consumed_at=clock_timestamp() WHERE id=$1::uuid',[d.intentId]);
  await c.query('COMMIT');committed=true;
 }catch{throw Error('outbound_local_intent_denied_or_unknown_no_replay');}
 finally{if(!committed)try{await c.query('ROLLBACK');}catch{}c.release();}
}
