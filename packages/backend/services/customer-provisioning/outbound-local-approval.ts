import {queryOne} from '../../db/pg-repo.js';import type {OutboundLocalApproval} from './outbound-vault-ports.js';
export interface InstalledOutboundApproval {organizationId:string;instanceId:string;executionId:string;approvalHash:string;deliveries:Array<{deliveryId:string;intentId:string;provider:'zuplo'|'litellm';policyHash:string;credentialId:string}>;}
/** Trusted installation selection, never built from a received delivery. Existing local
 * approval tables own actor/Project and revocation. No runtime schema publication here.
 */
export function outboundLocalApproval(installed:()=>Promise<InstalledOutboundApproval>):OutboundLocalApproval['resolve']{
 return async d=>{
  const config=await installed(),b=d.binding;
  if(config.organizationId!==b.organizationId||config.instanceId!==b.instanceId||config.executionId!==b.executionId||!/^[a-f0-9]{64}$/.test(config.approvalHash))throw Error('outbound_installed_identity_mismatch');
  const matches=config.deliveries.filter(x=>x.deliveryId===b.deliveryId&&x.intentId===b.intentId&&x.provider===b.provider&&x.policyHash===b.policyHash);if(matches.length!==1)throw Error('outbound_installed_delivery_denied');const target=matches[0];
  const row=await queryOne<{customer_id:string;instance_id:string;project_id:string;actor_user_id:string|number;credential_id:string;expires_at:Date|string}>(`SELECT a.customer_id,a.instance_id,a.project_id,a.actor_user_id,v.credential_id,LEAST(a.expires_at,i.expires_at) expires_at
   FROM customer_runtime_approvals a JOIN customer_service_intents i ON i.approval_hash=a.approval_hash AND i.instance_id=a.instance_id AND i.customer_id=a.customer_id AND i.project_id=a.project_id AND i.actor_user_id=a.actor_user_id
   JOIN customer_delivery_intents v ON v.id=i.id
   WHERE a.approval_hash=$1 AND a.instance_id=$2::uuid AND a.revoked=false AND a.expires_at>clock_timestamp() AND 'enrollment-issue'=ANY(a.operations)
   AND i.id=$3::uuid AND i.operation='enrollment-issue' AND i.provider_kind=$4 AND i.revoked=false AND i.expires_at>clock_timestamp()
   AND v.policy_hash=$5 AND v.credential_id=$6`,[config.approvalHash,b.instanceId,b.intentId,b.provider,b.policyHash,target.credentialId]);
  if(!row||!Number.isSafeInteger(Number(row.actor_user_id))||Number(row.actor_user_id)<=0||!Number.isFinite(Date.parse(b.expiresAt))||Date.parse(b.expiresAt)>new Date(row.expires_at).getTime())throw Error('outbound_local_approval_unavailable');
  return {organizationId:config.organizationId,executionId:config.executionId,deliveryId:target.deliveryId,approved:{intentId:target.intentId,customerId:row.customer_id,instanceId:row.instance_id,approvalHash:config.approvalHash,policyHash:target.policyHash,providerKind:target.provider,credentialId:row.credential_id},binding:{customerId:row.customer_id,instanceId:row.instance_id,projectId:row.project_id,actorUserId:Number(row.actor_user_id)}};
 };
}
