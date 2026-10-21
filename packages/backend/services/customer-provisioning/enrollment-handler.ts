import {authorizeCustomerService,type CustomerServiceAuthority,type CustomerRuntimeBinding,type CustomerServiceRequest} from './service-boundary.js';
export interface EnrollmentTarget {providerKind:'zuplo'|'litellm';credentialId:string;policyHash:string;}
export interface EnrollmentReadback extends EnrollmentTarget {customerId:string;instanceId:string;providerResourceId:string;stored:true;}
export interface CustomerEnrollmentServicePorts {
 /** Must load immutable approved policy, never accept scope/policy/actor chosen by a caller. */
 approvedTarget(request:CustomerServiceRequest,binding:CustomerRuntimeBinding):Promise<EnrollmentTarget>;
 issueAndStore(target:EnrollmentTarget,binding:CustomerRuntimeBinding,intentId:string):Promise<void>;
 readback(target:EnrollmentTarget,binding:CustomerRuntimeBinding):Promise<EnrollmentReadback>;
}
/** Secret-free enrollment core. Concrete provider/Vault ports and HTTP registration intentionally remain disabled. */
export async function runCustomerEnrollmentService(raw:unknown,authorization:string|undefined,config:{serviceToken?:string;authority:CustomerServiceAuthority;ports:CustomerEnrollmentServicePorts}):Promise<EnrollmentReadback>{
 // Validate the operation before any authority action or mutation intent is consumed.
 if(!raw||typeof raw!=='object'||!['enrollment-readback','enrollment-issue'].includes((raw as {operation:string}).operation))throw Error('customer_enrollment_operation_invalid');
 const {request,binding}=await authorizeCustomerService(raw,authorization,config.serviceToken,config.authority);
 let target:EnrollmentTarget;
 try{target=await config.ports.approvedTarget(request,binding);}catch{throw Error('customer_enrollment_policy_unavailable');}
 const safe=/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
 if(!target||target.providerKind!==request.providerKind||!['zuplo','litellm'].includes(target.providerKind)||!safe.test(target.credentialId)||!/^[a-f0-9]{64}$/.test(target.policyHash))throw Error('customer_enrollment_policy_invalid');
 if(request.operation==='enrollment-issue'){
  try{await config.ports.issueAndStore(target,binding,request.intentId!);}catch{throw Error('customer_enrollment_outcome_unknown');}
 }
 let x:EnrollmentReadback;
 try{x=await config.ports.readback(target,binding);}catch{throw Error('customer_enrollment_readback_unavailable');}
 if(!x||x.customerId!==binding.customerId||x.instanceId!==binding.instanceId||x.providerKind!==target.providerKind||x.credentialId!==target.credentialId||x.policyHash!==target.policyHash||x.stored!==true||!safe.test(x.providerResourceId))throw Error('customer_enrollment_readback_mismatch');
 return {customerId:x.customerId,instanceId:x.instanceId,providerKind:x.providerKind,credentialId:x.credentialId,policyHash:x.policyHash,providerResourceId:x.providerResourceId,stored:true};
}
