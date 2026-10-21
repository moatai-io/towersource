import {upsertApiKeyCredential} from '../credential-vault/credential-vault-service.js';
import {assertCustomerLocalVaultAccess} from './local-vault-access.js';
import {configureCustomerLiteLLMFromVault,assertCustomerLiteLLMBinding,activateCustomerLiteLLMRuntime} from '../ai/litellm-setup.js';
import type {ApprovedDelivery,CustomerCredentialReceiverPorts,DeliveryReceipt} from './central-delivery.js';
import type {CustomerRuntimeBinding} from './service-boundary.js';
export interface CustomerVaultDeliveryAuthority {
 /** Independently verifies local instance identity and approved provider/policy/credential destination. */
 resolve(input:ApprovedDelivery):Promise<CustomerRuntimeBinding>;
 /** Destination absence must be verified/locked before central issuance and again before local store. */
 assertDestinationAbsent(input:ApprovedDelivery,binding:CustomerRuntimeBinding):Promise<void>;
 consume(input:ApprovedDelivery,binding:CustomerRuntimeBinding):Promise<void>;
 readback(input:ApprovedDelivery,binding:CustomerRuntimeBinding):Promise<DeliveryReceipt>;
 /** Actual server-owned identity from the canonical persisted Vault row. */
 secretReference?(input:ApprovedDelivery,binding:CustomerRuntimeBinding):Promise<string>;
}
export interface CustomerGatewaySetup {
 preflight(input:ApprovedDelivery,binding:CustomerRuntimeBinding):Promise<void>;
 apply(input:ApprovedDelivery,binding:CustomerRuntimeBinding,receipt:DeliveryReceipt):Promise<void>;
 verify(input:ApprovedDelivery,binding:CustomerRuntimeBinding,receipt:DeliveryReceipt):Promise<void>;
}
export interface CustomerInferenceSetup {
 /** Local immutable approved inference URL, never provided by a delivery request. */
 approvedBaseUrl(input:ApprovedDelivery,binding:CustomerRuntimeBinding):Promise<string>;
 approvedProfile?(input:ApprovedDelivery):Promise<import('../ai/customer-model-bootstrap.js').CustomerAiProfile|undefined>;
}
export interface CustomerVaultReceiverDependencies {
 store:typeof upsertApiKeyCredential;access:typeof assertCustomerLocalVaultAccess;
 configure:typeof configureCustomerLiteLLMFromVault;verify:typeof assertCustomerLiteLLMBinding;
 activate:typeof activateCustomerLiteLLMRuntime;
}
/** Explicit customer-side store adapter. Never resolves or stores provider management keys. */
export function customerVaultReceiver(authority:CustomerVaultDeliveryAuthority,deps:Pick<CustomerVaultReceiverDependencies,'store'|'access'> & Partial<Pick<CustomerVaultReceiverDependencies,'configure'|'verify'|'activate'>>={store:upsertApiKeyCredential,access:assertCustomerLocalVaultAccess},inference?:CustomerInferenceSetup,gateway?:CustomerGatewaySetup):CustomerCredentialReceiverPorts{
 const activated=new Set<string>();
 async function ensureActive(config:{baseUrl:string;actorUserId:number;secretName:string}){
  const identity=config.baseUrl+'\0'+config.secretName;
  if(activated.has(identity))return;
  await (deps.activate??activateCustomerLiteLLMRuntime)();activated.add(identity);
 }
 async function binding(input:ApprovedDelivery){
  if(!/^[a-z0-9][a-z0-9_-]{1,79}$/.test(input.credentialId))throw Error('customer_delivery_credential_id_invalid');
  const b=await authority.resolve(input);
  if(!b||b.instanceId!==input.instanceId||b.customerId!==input.customerId)throw Error('customer_delivery_instance_mismatch');
  await deps.access(b);return b;
 }
 async function setup(input:ApprovedDelivery,b:CustomerRuntimeBinding){
  if(input.providerKind!=='litellm')return undefined;
  if(!inference)throw Error('customer_inference_setup_unavailable');
  const baseUrl=await inference.approvedBaseUrl(input,b);
  try{const u=new URL(baseUrl);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error();}catch{throw Error('customer_inference_setup_invalid');}
  const customerProfile=await inference?.approvedProfile?.(input);
  if(customerProfile!==undefined&&customerProfile!=='gpt-only')throw Error('customer_inference_setup_invalid');
  return {baseUrl,actorUserId:b.actorUserId,...(customerProfile?{customerProfile}:{})};
 }
 return {
  async verifyLocalAuthority(input){const b=await binding(input);await setup(input,b);if(input.providerKind==='zuplo'&&gateway)await gateway.preflight(input,b);await authority.assertDestinationAbsent(input,b);},
  async consumeDeliveryIntent(input){await authority.consume(input,await binding(input));},
  async store(input){
   const b=await binding(input);const config=await setup(input,b);if(input.providerKind==='zuplo'&&gateway)await gateway.preflight(input,b);await authority.assertDestinationAbsent(input,b);
   // Env name is selected by the approved provider kind, never by the remote caller.
   const envName=input.providerKind==='zuplo'?'ZUPLO_VIRTUAL_KEY':'LITELLM_API_KEY';
   const stored=await deps.store({id:input.credentialId,provider:input.providerKind,displayName:'Customer '+input.providerKind+' virtual key',secretName:envName,defaultEnvName:envName,secretValue:input.value,scope:'workspace',actorUserId:b.actorUserId,metadata:{customerId:input.customerId,instanceId:input.instanceId,providerResourceId:input.providerResourceId,policyHash:input.policyHash,approvalHash:input.approvalHash,deliveryIntentId:input.intentId}});
   // A failed setup leaves the issued Vault row for recovery, never for reissue.
   if(config){
    if(!stored||!/^VAULT_[A-F0-9]{56}$/.test(stored.secret_name))throw Error('customer_vault_storage_reference_unverified');
    const persisted={...config,secretName:stored.secret_name};
    await (deps.configure??configureCustomerLiteLLMFromVault)(persisted);await ensureActive(persisted);
   }
   if(input.providerKind==='zuplo'&&gateway){const receipt=await authority.readback(input,b);await gateway.apply(input,b,receipt);}
  },
  async readback(input){
   const b=await binding(input);const receipt=await authority.readback(input,b);const config=await setup(input,b);
   if(config){
    const secretName=await authority.secretReference?.(input,b);
    if(!secretName||!/^VAULT_[A-F0-9]{56}$/.test(secretName))throw Error('customer_vault_storage_reference_unverified');
    const persisted={...config,secretName};(deps.verify??assertCustomerLiteLLMBinding)(persisted);await ensureActive(persisted);
   }
   if(input.providerKind==='zuplo'&&gateway)await gateway.verify(input,b,receipt);
   return receipt;
  },
 };
}
