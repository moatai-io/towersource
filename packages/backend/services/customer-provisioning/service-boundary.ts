import { timingSafeEqual } from 'node:crypto';

export type CustomerServiceOperation='enrollment-readback'|'enrollment-issue'|'smoke-usage'|'smoke-estimate'|'smoke-execute';
export interface CustomerServiceRequest {
 customerId:string;instanceId:string;approvalHash:string;operation:CustomerServiceOperation;model?:string;intentId?:string;providerKind?:'zuplo'|'litellm';
}
export interface CustomerRuntimeBinding {
 customerId:string;instanceId:string;projectId:string;actorUserId:number;smokeModel?:string;
}
export interface CustomerServiceAuthority {
 /** Must independently read local instance identity and active actor/project/workspace Vault authority. */
 readRuntimeBinding():Promise<CustomerRuntimeBinding>;
 authorize(input:CustomerServiceRequest & {binding:CustomerRuntimeBinding}):Promise<void>;
 /** Atomic, durable single-winner fence. Ambiguous execution must never release a consumed intent. */
 consumeIntent(input:CustomerServiceRequest & {binding:CustomerRuntimeBinding;intentId:string}):Promise<void>;
}
const id=/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const customerSmokeModels=['gpt-6.1-sol','~deepseek/deepseek-pro-latest'] as const;
export function isCustomerSmokeModel(value:unknown):value is string{return typeof value==='string'&&(customerSmokeModels as readonly string[]).includes(value);}
const operations:CustomerServiceOperation[]=['enrollment-readback','enrollment-issue','smoke-usage','smoke-estimate','smoke-execute'];
export function parseCustomerServiceRequest(raw:unknown):CustomerServiceRequest {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('customer_service_request_invalid');
 const x=raw as Record<string,unknown>,allowed=['customerId','instanceId','approvalHash','operation','intentId','providerKind','model'];
 if(Object.keys(x).some(k=>!allowed.includes(k))||typeof x.customerId!=='string'||!id.test(x.customerId)||typeof x.instanceId!=='string'||!uuid.test(x.instanceId)||typeof x.approvalHash!=='string'||!/^[a-f0-9]{64}$/.test(x.approvalHash)||!operations.includes(x.operation as CustomerServiceOperation)||(x.intentId!==undefined&&(typeof x.intentId!=='string'||!uuid.test(x.intentId))))throw Error('customer_service_request_invalid');
 const enrollment=x.operation==='enrollment-issue'||x.operation==='enrollment-readback';
 if(enrollment?!['zuplo','litellm'].includes(x.providerKind as string):x.providerKind!==undefined)throw Error('customer_service_provider_invalid');
 const mutation=x.operation==='enrollment-issue'||x.operation==='smoke-execute';
 if(mutation&&!x.intentId)throw Error('customer_service_intent_required');
 if(x.model!==undefined&&(!String(x.operation).startsWith('smoke-')||!isCustomerSmokeModel(x.model)))throw Error('customer_service_model_invalid');
 return structuredClone(x) as unknown as CustomerServiceRequest;
}
/** Independent of HTTP framework. Disabled unless an explicit service token and complete authority implementation are supplied. */
export async function authorizeCustomerService(
 raw:unknown,authorization:string|undefined,serviceToken:string|undefined,authority:CustomerServiceAuthority,
):Promise<{request:CustomerServiceRequest;binding:CustomerRuntimeBinding}>{
 if(!serviceToken||serviceToken.length<32)throw Error('customer_service_disabled');
 const expected=Buffer.from(`Bearer ${serviceToken}`),actual=Buffer.from(authorization||'');
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('customer_service_unauthenticated');
 const request=parseCustomerServiceRequest(raw);let binding:CustomerRuntimeBinding;
 try{binding=await authority.readRuntimeBinding();}catch{throw Error('customer_service_authority_unavailable');}
 if(!binding||binding.customerId!==request.customerId||binding.instanceId!==request.instanceId||!uuid.test(binding.projectId)||!Number.isSafeInteger(binding.actorUserId)||binding.actorUserId<=0)throw Error('customer_service_instance_mismatch');
 try{await authority.authorize({...request,binding});}catch{throw Error('customer_service_approval_denied');}
 if(request.operation.startsWith('smoke-')&&(!isCustomerSmokeModel(binding.smokeModel)||(request.model!==undefined&&request.model!==binding.smokeModel)))throw Error('customer_service_smoke_model_denied');
 if(request.operation==='enrollment-issue'||request.operation==='smoke-execute'){
  try{await authority.consumeIntent({...request,binding,intentId:request.intentId!});}catch{throw Error('customer_service_intent_denied');}
 }
 return {request,binding};
}
