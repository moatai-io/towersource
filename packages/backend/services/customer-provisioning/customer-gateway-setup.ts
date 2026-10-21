import {createHash} from 'node:crypto';
import {queryOne} from '../../db/pg-repo.js';
import {getPgPool} from '../../db/pg.js';
import {assertLockedCustomerAuthority} from './pg-locked-authority.js';
import {readCustomerGatewayPolicy} from './customer-gateway-policy-readback.js';
import type {ApprovedDelivery,DeliveryReceipt} from './central-delivery.js';
import type {CustomerRuntimeBinding} from './service-boundary.js';
export interface ApprovedGatewaySetup {profileId:string;gatewayBaseUrl:string;policy:{profileVersion:string;enabledApiIds:string[];quotaMode:'observe'};}
const canonical=(x:any):string=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
export function validateGatewaySetup(d:ApprovedDelivery,p:ApprovedGatewaySetup){
 const u=new URL(p.gatewayBaseUrl);
 if(d.providerKind!=='zuplo'||u.protocol!=='https:'||u.username||u.password||u.search||u.hash||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(p.profileId)||!/^\d+$/.test(p.policy.profileVersion)||Number(p.policy.profileVersion)<1||p.policy.quotaMode!=='observe'||!p.policy.enabledApiIds.length||new Set(p.policy.enabledApiIds).size!==p.policy.enabledApiIds.length||p.policy.enabledApiIds.some(x=>!/^[A-Za-z0-9_-]+$/.test(x))||createHash('sha256').update(canonical(p.policy)).digest('hex')!==d.policyHash)throw Error('gateway_setup_policy_invalid');
}
/** Fresh authority lock + existing seed only. Never reports ready or performs provider issuance. */
export async function applyCustomerGatewaySetup(d:ApprovedDelivery,b:CustomerRuntimeBinding,r:DeliveryReceipt,p:ApprovedGatewaySetup){
 validateGatewaySetup(d,p);if(r.stored!==true||(['intentId','customerId','instanceId','approvalHash','policyHash','providerKind','credentialId'] as const).some(k=>d[k as keyof ApprovedDelivery]!==r[k as keyof ApprovedDelivery])||!r.providerResourceId)throw Error('gateway_setup_receipt_invalid');
 const c=await getPgPool().connect();let committed=false;
 try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");await assertLockedCustomerAuthority(c,{...d,operation:'enrollment-issue',binding:b});
  const profile=await c.query('SELECT id,credential_id,consumer_ref FROM gateway_profiles WHERE id=$1 FOR UPDATE',[p.profileId]);
  const old=profile.rows[0];if(!old||(old.credential_id&&old.credential_id!==d.credentialId)||(old.consumer_ref&&old.consumer_ref!==r.providerResourceId))throw Error('gateway_setup_existing_binding_conflict');
  const entries=await c.query('SELECT api_id FROM gateway_profile_catalog_entries WHERE profile_id=$1 FOR UPDATE',[p.profileId]);
  if(p.policy.enabledApiIds.some(id=>!entries.rows.some(e=>e.api_id===id)))throw Error('gateway_setup_catalog_missing');
  const credential=await c.query("SELECT id FROM workspace_credentials WHERE id=$1 AND provider='zuplo' AND scope='workspace' AND enabled=true AND metadata->>'providerResourceId'=$2 AND metadata->>'policyHash'=$3 AND metadata->>'instanceId'=$4 FOR SHARE",[d.credentialId,r.providerResourceId,d.policyHash,d.instanceId]);if(credential.rowCount!==1)throw Error('gateway_setup_vault_binding_missing');
  const stateHash=createHash('sha256').update(canonical({profileId:p.profileId,gatewayBaseUrl:p.gatewayBaseUrl,credentialId:d.credentialId,consumerRef:r.providerResourceId,policy:p.policy})).digest('hex');
  await c.query("UPDATE gateway_profiles SET version=$2::integer,gateway_base_url=$3,credential_id=$4,consumer_ref=$5,desired_state_hash=$6,applied_state_hash=$6,status='pending',last_verified_at=NULL,last_error_code=NULL,updated_at=NOW() WHERE id=$1",[p.profileId,p.policy.profileVersion,p.gatewayBaseUrl,d.credentialId,r.providerResourceId,stateHash]);
  await c.query("UPDATE gateway_profile_catalog_entries SET enabled=(api_id=ANY($2::text[])),quota_mode='observe',readiness='unverified',updated_at=NOW() WHERE profile_id=$1",[p.profileId,p.policy.enabledApiIds]);
  await c.query('COMMIT');committed=true;
 }finally{if(!committed)try{await c.query('ROLLBACK');}catch{}c.release();}
}
export async function verifyCustomerGatewaySetup(d:ApprovedDelivery,b:CustomerRuntimeBinding,r:DeliveryReceipt,p:ApprovedGatewaySetup){
 validateGatewaySetup(d,p);const actual=await readCustomerGatewayPolicy({instanceId:d.instanceId,profileId:p.profileId,credentialId:d.credentialId,consumerRef:r.providerResourceId},async()=>b.instanceId);
 if(canonical(actual.policy)!==canonical({...p.policy,enabledApiIds:[...p.policy.enabledApiIds].sort()}))throw Error('gateway_setup_readback_mismatch');
}

/** Read-only prerequisite before issuing provider credentials. Post-store transaction rechecks all rows. */
export async function preflightCustomerGatewaySetup(d:ApprovedDelivery,p:ApprovedGatewaySetup){
 validateGatewaySetup(d,p);
 const row=await queryOne<{credential_id:string|null;consumer_ref:string|null;apis:string[]}>(`SELECT p.credential_id,p.consumer_ref,COALESCE((SELECT array_agg(api_id) FROM gateway_profile_catalog_entries WHERE profile_id=p.id),ARRAY[]::text[]) apis FROM gateway_profiles p WHERE p.id=$1`,[p.profileId]);
 if(!row||row.credential_id||row.consumer_ref||p.policy.enabledApiIds.some(id=>!row.apis.includes(id)))throw Error('gateway_setup_preflight_denied');
}
