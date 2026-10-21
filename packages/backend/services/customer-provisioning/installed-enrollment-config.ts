import {customerRuntimeAuthority,type CustomerRuntimeAuthorityStore} from './runtime-authority.js';
import type {CustomerEnrollmentServicePorts} from './enrollment-handler.js';
import type {bootstrapApprovedCustomerOwner} from './owner-bootstrap.js';
type Owner=Awaited<ReturnType<typeof bootstrapApprovedCustomerOwner>>;
/** Compose an installed receiver only after independent DB/Vault authority readback agrees with bootstrap. */
export async function installedEnrollmentConfig(owner:Readonly<Owner>,store:CustomerRuntimeAuthorityStore,ports:CustomerEnrollmentServicePorts,serviceToken:string){
 if(typeof serviceToken!=='string'||serviceToken.length<32||typeof ports?.approvedTarget!=='function'||typeof ports?.issueAndStore!=='function'||typeof ports?.readback!=='function')throw Error('installed_enrollment_config_invalid');
 const expected=Object.freeze({...owner});
 const bound:CustomerRuntimeAuthorityStore={
  localInstanceId:()=>store.localInstanceId(),assertLocalAccess:b=>store.assertLocalAccess(b),consumeApprovedIntent:x=>store.consumeApprovedIntent(x),
  async approvedRuntime(){
   const approved=await store.approvedRuntime();
   if(approved.approvalHash!==expected.approvalHash)throw Error('installed_enrollment_approval_mismatch');
   for(const k of ['customerId','instanceId','projectId','actorUserId'] as const)if(approved[k]!==expected[k])throw Error('installed_enrollment_owner_mismatch');
   return approved;
  }
 };
 const authority=customerRuntimeAuthority(bound);
 const binding=await authority.readRuntimeBinding();
 for(const k of ['customerId','instanceId','projectId','actorUserId'] as const)if(binding[k]!==owner[k])throw Error('installed_enrollment_owner_mismatch');
 return {serviceToken,authority,ports};
}
