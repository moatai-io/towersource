import {queryOne} from '../../db/pg-repo.js';
import {assertCustomerLocalVaultAccess} from './local-vault-access.js';
import type {ApprovedDelivery,CustomerCredentialReceiverPorts,DeliveryReceipt} from './central-delivery.js';
import type {CustomerRuntimeBinding} from './service-boundary.js';
import type {OutboundClientPorts,OutboundDelivery,OutboundStoredReceipt} from './outbound-enrollment-client.js';
export interface OutboundLocalApproval {
 resolve(delivery:Readonly<OutboundDelivery>):Promise<{organizationId:string;executionId:string;deliveryId:string;approved:ApprovedDelivery;binding:CustomerRuntimeBinding}>;
 receiver:CustomerCredentialReceiverPorts;
}
/** Reuse canonical receiver store/setup/readback. Never treats readback failure as absence.
 * Local approval resolver is mandatory; values from remote payload cannot select Vault destination.
 */
export function outboundVaultPorts(authority:OutboundLocalApproval):OutboundClientPorts{
 async function resolve(d:Readonly<OutboundDelivery>){const a=await authority.resolve(d),b=d.binding;
  if(a.organizationId!==b.organizationId||a.executionId!==b.executionId||a.deliveryId!==b.deliveryId||a.approved.instanceId!==b.instanceId||a.approved.intentId!==b.intentId||a.approved.providerKind!==b.provider||a.approved.policyHash!==b.policyHash||a.binding.instanceId!==b.instanceId||a.binding.customerId!==a.approved.customerId)throw Error('outbound_local_approval_mismatch');
  await assertCustomerLocalVaultAccess(a.binding);return a;
 }
 function receipt(d:Readonly<OutboundDelivery>,a:ApprovedDelivery,r:DeliveryReceipt):OutboundStoredReceipt{
  for(const k of ['intentId','customerId','instanceId','approvalHash','policyHash','providerKind','credentialId'] as const)if(r[k]!==a[k])throw Error('outbound_vault_receipt_mismatch');
  if(r.stored!==true||r.providerResourceId!==d.providerResourceId)throw Error('outbound_vault_resource_mismatch');
  const b=d.binding;return {deliveryId:b.deliveryId,instanceId:b.instanceId,executionId:b.executionId,intentId:b.intentId,provider:b.provider,policyHash:b.policyHash,providerResourceId:r.providerResourceId,stored:true};
 }
 return {async authorize(d){await resolve(d);},async readStored(d){const a=await resolve(d);const env=a.approved.providerKind==='zuplo'?'ZUPLO_VIRTUAL_KEY':'LITELLM_API_KEY';
  const row=await queryOne<{id:string}>("SELECT id FROM workspace_credentials WHERE id=$1 OR (scope='workspace' AND COALESCE(default_env_name,secret_name)=$2) LIMIT 1",[a.approved.credentialId,env]);
  if(!row)return null;if(row.id!==a.approved.credentialId)throw Error('outbound_vault_destination_conflict');
  return receipt(d,a.approved,await authority.receiver.readback(a.approved));
 },async storeAndVerify(d){const a=await resolve(d);await authority.receiver.verifyLocalAuthority(a.approved);
  await authority.receiver.consumeDeliveryIntent(a.approved);
  await authority.receiver.store({...a.approved,providerResourceId:d.providerResourceId,value:d.value});
  return receipt(d,a.approved,await authority.receiver.readback(a.approved));
 }};
}
