import {isCustomerSmokeModel} from './service-boundary.js';
import type {CustomerRuntimeBinding,CustomerServiceAuthority,CustomerServiceOperation,CustomerServiceRequest} from './service-boundary.js';

export interface ApprovedCustomerRuntime {
 customerId:string;instanceId:string;projectId:string;actorUserId:number;approvalHash:string;
 expiresAt:string;revoked:boolean;operations:CustomerServiceOperation[];smokeModel?:string;
}
export interface CustomerRuntimeAuthorityStore {
 /** Local instance identity must not originate from caller request fields. */
 localInstanceId():Promise<string>;
 approvedRuntime():Promise<ApprovedCustomerRuntime>;
 /** Independently verifies active user, Project access and workspace Credential admin authority. */
 assertLocalAccess(binding:CustomerRuntimeBinding):Promise<void>;
 /** Must atomically verify approval/current authority and persist consumed intent scoped by operation/provider/instance. */
 consumeApprovedIntent(input:CustomerServiceRequest & {binding:CustomerRuntimeBinding;intentId:string}):Promise<void>;
}
/** No production DB implementation is selected implicitly. A deployment must supply all trusted store operations. */
export function customerRuntimeAuthority(store:CustomerRuntimeAuthorityStore,now:()=>number=Date.now):CustomerServiceAuthority {
 async function current(){
  const [instanceId,x]=await Promise.all([store.localInstanceId(),store.approvedRuntime()]);
  if(!x||x.instanceId!==instanceId||x.revoked!==false||!Number.isFinite(Date.parse(x.expiresAt))||Date.parse(x.expiresAt)<=now()||!Array.isArray(x.operations))throw Error('runtime_approval_unavailable');
  const binding={customerId:x.customerId,instanceId:x.instanceId,projectId:x.projectId,actorUserId:x.actorUserId,...(x.smokeModel?{smokeModel:x.smokeModel}:{})};
  await store.assertLocalAccess(binding);return {x,binding};
 }
 return {
  async readRuntimeBinding(){return (await current()).binding;},
  async authorize(input){
   const {x,binding}=await current();
  if(input.operation.startsWith('smoke-')&&(!isCustomerSmokeModel(x.smokeModel)||x.smokeModel!==input.binding.smokeModel||(input.model!==undefined&&input.model!==x.smokeModel)))throw Error('customer_runtime_smoke_model_denied');

   if(input.customerId!==x.customerId||input.instanceId!==x.instanceId||input.approvalHash!==x.approvalHash||input.binding.projectId!==binding.projectId||input.binding.actorUserId!==binding.actorUserId||!x.operations.includes(input.operation))throw Error('runtime_approval_mismatch');
  },
  async consumeIntent(input){
   // Recheck just before the store's independent atomic authorization fence.
   await this.authorize(input);await store.consumeApprovedIntent(input);
  },
 };
}
