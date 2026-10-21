import {queryOne} from '../../db/pg-repo.js';
import {resolveProjectCredentialSecretValue} from '../credential-vault/credential-vault-service.js';
import {assertCustomerLocalVaultAccess} from './local-vault-access.js';
import type {ApprovedDelivery,DeliveryReceipt} from './central-delivery.js';
import type {CustomerRuntimeBinding} from './service-boundary.js';
/** Local storage readback; central service must additionally verify provider resource/policy independently. */
async function verifiedCustomerVaultRow(input:ApprovedDelivery,binding:CustomerRuntimeBinding){
 if(binding.customerId!==input.customerId||binding.instanceId!==input.instanceId)throw Error('customer_vault_instance_mismatch');
 await assertCustomerLocalVaultAccess(binding);
 const x=await queryOne<{kind:string;provider:string;scope:string;project_id:string|null;secret_name:string;default_env_name:string;enabled:boolean;metadata:Record<string,unknown>}>('SELECT kind,provider,scope,project_id,secret_name,default_env_name,enabled,metadata FROM workspace_credentials WHERE id=$1',[input.credentialId]);
 const env=input.providerKind==='zuplo'?'ZUPLO_VIRTUAL_KEY':'LITELLM_API_KEY';
 if(!x||x.kind!=='api_key'||x.provider!==input.providerKind||x.scope!=='workspace'||x.project_id!==null||!/^VAULT_[A-F0-9]{56}$/.test(x.secret_name)||x.default_env_name!==env||x.enabled!==true||x.metadata.customerId!==input.customerId||x.metadata.instanceId!==input.instanceId||x.metadata.policyHash!==input.policyHash||x.metadata.approvalHash!==input.approvalHash||x.metadata.deliveryIntentId!==input.intentId||typeof x.metadata.providerResourceId!=='string')throw Error('customer_vault_readback_mismatch');
 // Verify actual stored material exists, using canonical audited resolver. Never return value.
 const secret=await resolveProjectCredentialSecretValue({projectId:binding.projectId,userId:binding.actorUserId,credentialId:input.credentialId,kind:'api_key',provider:input.providerKind,targetType:'customer-delivery-readback'});
 if(!secret||!secret.value.trim())throw Error('customer_vault_material_missing');
 if(secret.secretName!==x.secret_name||secret.credentialId!==input.credentialId||secret.provider!==input.providerKind||secret.kind!=='api_key')throw Error('customer_vault_storage_reference_changed');
 return x;
}
export async function readCustomerVaultDelivery(input:ApprovedDelivery,binding:CustomerRuntimeBinding):Promise<DeliveryReceipt>{
 const x=await verifiedCustomerVaultRow(input,binding);return {...input,providerResourceId:x.metadata.providerResourceId as string,stored:true};
}
export async function readCustomerVaultSecretReference(input:ApprovedDelivery,binding:CustomerRuntimeBinding):Promise<string>{
 return (await verifiedCustomerVaultRow(input,binding)).secret_name;
}
/** Creation-only delivery must not silently rotate an existing credential or overwrite an env binding. */
export async function assertCustomerVaultDestinationAbsent(input:ApprovedDelivery,binding:CustomerRuntimeBinding):Promise<void>{
 if(binding.customerId!==input.customerId||binding.instanceId!==input.instanceId)throw Error('customer_vault_instance_mismatch');
 await assertCustomerLocalVaultAccess(binding);const env=input.providerKind==='zuplo'?'ZUPLO_VIRTUAL_KEY':'LITELLM_API_KEY';
 const collision=await queryOne('SELECT id FROM workspace_credentials WHERE id=$1 OR (scope=\'workspace\' AND COALESCE(default_env_name,secret_name)=$2) LIMIT 1',[input.credentialId,env]);
 if(collision)throw Error('customer_vault_destination_conflict');
}
