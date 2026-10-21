import type {ApprovedDelivery,CentralIssuancePorts,DeliveryReceipt} from './central-delivery.js';
import type {EnrollmentTarget,CustomerEnrollmentServicePorts} from './enrollment-handler.js';
import type {CustomerRuntimeBinding,CustomerServiceRequest} from './service-boundary.js';
import {autoEnrollAndDeliverLiteLlmCustomer,readApprovedAutoLiteLlmCustomer,type AutoLiteLlmEnrollmentPolicy} from './litellm-auto-enrollment.js';
import type {LiteLlmManagementPort} from './litellm-key-issuer.js';
export interface ApprovedLiteLlmEnrollment {
 delivery:ApprovedDelivery;policy:AutoLiteLlmEnrollmentPolicy;
}
export interface LiteLlmEnrollmentAuthority {
 /** Load exact immutable plan/target and original delivery intent from durable state.
  * Readback uses that original intent, never manufactures another one. */
 approved(request:CustomerServiceRequest,binding:CustomerRuntimeBinding):Promise<ApprovedLiteLlmEnrollment>;
}
/** Central enrollment entrypoint composition. The management port stays central;
 * delivery transports send the customer virtual key directly to its receiver.
 * Caller supplies durable authority, not a provider policy in an HTTP body. */
export function liteLlmEnrollmentPorts(authority:LiteLlmEnrollmentAuthority,management:LiteLlmManagementPort,ports:Omit<CentralIssuancePorts,'issue'>):CustomerEnrollmentServicePorts{
 function matches(x:ApprovedLiteLlmEnrollment,request:CustomerServiceRequest,binding:CustomerRuntimeBinding){
  if(!x||x.delivery.providerKind!=='litellm'||request.providerKind!=='litellm'||x.delivery.customerId!==binding.customerId||x.delivery.instanceId!==binding.instanceId||x.delivery.approvalHash!==request.approvalHash||!['enrollment-issue','enrollment-readback'].includes(request.operation))throw Error('litellm_enrollment_binding_mismatch');
  if(request.operation==='enrollment-issue'&&x.delivery.intentId!==request.intentId)throw Error('litellm_enrollment_intent_mismatch');
  const p=x.policy;
  if(!p||['customerId','instanceId','approvalHash','policyHash','credentialId'].some(k=>p[k as keyof AutoLiteLlmEnrollmentPolicy]!==x.delivery[k as keyof ApprovedDelivery]))throw Error('litellm_enrollment_policy_mismatch');
  return structuredClone(x);
 }
 async function load(target:EnrollmentTarget,binding:CustomerRuntimeBinding,intentId?:string){
  const selected=target as EnrollmentTarget & {approvalHash?:string};
  if(typeof selected.approvalHash!=='string'||!/^[a-f0-9]{64}$/.test(selected.approvalHash))throw Error('litellm_enrollment_approval_missing');
  const request:CustomerServiceRequest={customerId:binding.customerId,instanceId:binding.instanceId,approvalHash:selected.approvalHash,providerKind:'litellm',operation:intentId?'enrollment-issue':'enrollment-readback',...(intentId?{intentId}:{})};
  // Reload exact approved state before every action; do not silently switch to a
  // newly published approval, or cache the initial resolver result across calls.
  const x=matches(await authority.approved(request,binding),request,binding);
  if(x.delivery.credentialId!==target.credentialId||x.delivery.policyHash!==target.policyHash||target.providerKind!=='litellm')throw Error('litellm_enrollment_target_mismatch');
  return x;
 }
 function receipt(x:DeliveryReceipt,expected:ApprovedDelivery){
  if(!x||Object.keys(x).length!==9||Object.keys(expected).some(k=>x[k as keyof ApprovedDelivery]!==expected[k as keyof ApprovedDelivery])||x.stored!==true||typeof x.providerResourceId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(x.providerResourceId))throw Error('litellm_enrollment_readback_mismatch');
  return {customerId:x.customerId,instanceId:x.instanceId,providerKind:x.providerKind,credentialId:x.credentialId,policyHash:x.policyHash,providerResourceId:x.providerResourceId,stored:true as const};
 }
 return {
  async approvedTarget(request,binding){const x=matches(await authority.approved(request,binding),request,binding);return Object.freeze({providerKind:'litellm' as const,credentialId:x.delivery.credentialId,policyHash:x.delivery.policyHash,approvalHash:x.delivery.approvalHash});},
  async issueAndStore(target,binding,intentId){const x=await load(target,binding,intentId);await autoEnrollAndDeliverLiteLlmCustomer(x.delivery,x.policy,management,ports);},
  async readback(target,binding){const x=await load(target,binding);const provider=await readApprovedAutoLiteLlmCustomer(x.delivery,x.policy,management);const stored=receipt(await ports.readback(x.delivery),x.delivery);if(stored.providerResourceId!==provider.providerResourceId)throw Error('litellm_enrollment_resource_mismatch');return stored;},
 };
}
