import type {CustomerServiceRequest,CustomerRuntimeBinding} from './service-boundary.js';
export interface CustomerIntentClient {query(sql:string,values?:unknown[]):Promise<{rowCount:number|null}>;release():void;}
export interface CustomerIntentPool {connect():Promise<CustomerIntentClient>;}
/** Caller supplies the approved local schema; no migration is applied by this adapter. */
export async function consumeCustomerIntent(pool:CustomerIntentPool,input:CustomerServiceRequest & {binding:CustomerRuntimeBinding;intentId:string},assertLockedAuthority:(client:CustomerIntentClient,input:CustomerServiceRequest & {binding:CustomerRuntimeBinding;intentId:string})=>Promise<void>){
 if(typeof assertLockedAuthority!=='function')throw Error('customer_intent_authority_missing');
 const c=await pool.connect();let committed=false;
 try{
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
  // Must lock/recheck current local approval and actor/Project/workspace ACL in this same transaction.
  await assertLockedAuthority(c,input);
  // Single-use ID is prepublished by the approval authority; UPDATE cannot manufacture an intent.
  const r=await c.query(`UPDATE customer_service_intents SET consumed_at=clock_timestamp()
   WHERE id=$1::uuid AND customer_id=$2 AND instance_id=$3::uuid AND approval_hash=$4
   AND operation=$5 AND provider_kind IS NOT DISTINCT FROM $6 AND project_id=$7::uuid AND actor_user_id=$8
   AND consumed_at IS NULL AND expires_at>clock_timestamp() AND revoked=false`,
  [input.intentId,input.customerId,input.instanceId,input.approvalHash,input.operation,input.providerKind??null,input.binding.projectId,input.binding.actorUserId]);
  if(r.rowCount!==1)throw Error('intent_not_consumable');
  await c.query('COMMIT');committed=true;
 }catch{if(!committed)try{await c.query('ROLLBACK');}catch{}throw Error('customer_intent_denied_or_unknown');}
 finally{c.release();}
}
