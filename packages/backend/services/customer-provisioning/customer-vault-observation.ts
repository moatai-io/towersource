import {queryOne} from '../../db/pg-repo.js';
import {assertCustomerLocalVaultAccess} from './local-vault-access.js';
import {readCustomerVaultDelivery} from './customer-vault-readback.js';
import {enrollmentObservationHttp,type ApprovedObservationTarget} from './enrollment-observation-http.js';
import type {ApprovedDelivery} from './central-delivery.js';
import type {CustomerRuntimeBinding} from './service-boundary.js';
export function customerVaultObservation(config:{token:string;targets:readonly ApprovedObservationTarget[];resolve(target:Readonly<ApprovedObservationTarget>):Promise<{delivery:ApprovedDelivery;binding:CustomerRuntimeBinding}>}){
 return enrollmentObservationHttp({token:config.token,kind:'vault',targets:config.targets,async read(target){
  const {delivery:d,binding:b}=await config.resolve(target);
  if(d.customerId!==target.customerId||d.instanceId!==target.instanceId||d.policyHash!==target.proposalHash||d.providerKind!==target.providerKind||b.customerId!==d.customerId||b.instanceId!==d.instanceId)throw Error('vault_observation_binding_mismatch');
  await assertCustomerLocalVaultAccess(b);
  // A positive collision is not absence: canonical readback below must validate it.
  const env=d.providerKind==='zuplo'?'ZUPLO_VIRTUAL_KEY':'LITELLM_API_KEY';
  const row=await queryOne<{id:string}>("SELECT id FROM workspace_credentials WHERE id=$1 OR (scope='workspace' AND COALESCE(default_env_name,secret_name)=$2) LIMIT 1",[d.credentialId,env]);
  if(!row)return null;
  if(row.id!==d.credentialId)throw Error('vault_observation_collision');
  const receipt=await readCustomerVaultDelivery(d,b);
  return {targetInstanceId:d.instanceId,credentialId:d.credentialId,providerKind:d.providerKind,providerResourceId:receipt.providerResourceId,policyHash:d.policyHash,registryRevision:d.policyHash};
 }});
}
