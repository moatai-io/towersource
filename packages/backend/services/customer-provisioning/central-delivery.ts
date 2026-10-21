import {timingSafeEqual} from 'node:crypto';
export interface ApprovedDelivery {
 intentId:string;customerId:string;instanceId:string;approvalHash:string;policyHash:string;
 providerKind:'zuplo'|'litellm';credentialId:string;
}
export interface DeliveryReceipt extends ApprovedDelivery {providerResourceId:string;stored:true;}
export interface CentralIssuancePorts {
 /** Atomic approved intent consumption and attested receiver check BEFORE issuance. */
 consumeAndVerifyReceiver(input:ApprovedDelivery):Promise<void>;
 issue(input:ApprovedDelivery):Promise<{providerResourceId:string;value:string}>;
 /** Secret travels only directly to the attested customer receiver, never to Control Plane. */
 deliver(input:ApprovedDelivery & {providerResourceId:string;value:string}):Promise<DeliveryReceipt>;
 readback(input:ApprovedDelivery):Promise<DeliveryReceipt>;
}
function validate(x:ApprovedDelivery){
 const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
 const id=/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
 if(!x||Object.keys(x).length!==7||!uuid.test(x.intentId)||!uuid.test(x.instanceId)||!id.test(x.customerId)||!id.test(x.credentialId)||!['zuplo','litellm'].includes(x.providerKind)||! /^[a-f0-9]{64}$/.test(x.approvalHash)||! /^[a-f0-9]{64}$/.test(x.policyHash))throw Error('delivery_binding_invalid');
}
function receipt(x:DeliveryReceipt,input:ApprovedDelivery,resource:string):DeliveryReceipt{
 if(!x||Object.keys(x).length!==9||Object.keys(input).some(k=>x[k as keyof ApprovedDelivery]!==input[k as keyof ApprovedDelivery])||x.providerResourceId!==resource||x.stored!==true)throw Error('delivery_readback_unverified');
 return {...input,providerResourceId:resource,stored:true};
}
/** No concrete issuance backend or management secret is selected implicitly. */
export async function issueAndDeliverCustomerCredential(input:ApprovedDelivery,ports:CentralIssuancePorts):Promise<DeliveryReceipt>{
 validate(input);const frozen=Object.freeze(structuredClone(input));
 try{await ports.consumeAndVerifyReceiver(frozen);}catch{throw Error('delivery_intent_denied');}
 let issued:{providerResourceId:string;value:string};
 try{issued=await ports.issue(frozen);}catch{throw Error('issuance_outcome_unknown_no_replay');}
 if(!issued||typeof issued.value!=='string'||!issued.value.trim()||typeof issued.providerResourceId!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(issued.providerResourceId))throw Error('issuance_outcome_unknown_no_replay');
 try{
  receipt(await ports.deliver({...frozen,providerResourceId:issued.providerResourceId,value:issued.value}),frozen,issued.providerResourceId);
  return receipt(await ports.readback(frozen),frozen,issued.providerResourceId);
 }catch{throw Error('delivery_recovery_required_no_reissue');}
 finally{issued.value='';} // Best-effort lifetime reduction; not a guarantee of JS memory zeroization.
}
export interface CustomerCredentialReceiverPorts {
 verifyLocalAuthority(input:ApprovedDelivery):Promise<void>;
 /** Atomic single-winner intent consumption before Vault mutation. */
 consumeDeliveryIntent(input:ApprovedDelivery):Promise<void>;
 store(input:ApprovedDelivery & {providerResourceId:string;value:string}):Promise<void>;
 readback(input:ApprovedDelivery):Promise<DeliveryReceipt>;
}
/** Private receiver core, not a mounted HTTP route. */
export async function receiveCustomerCredential(input:ApprovedDelivery & {providerResourceId:string;value:string},authorization:string|undefined,token:string|undefined,ports:CustomerCredentialReceiverPorts):Promise<DeliveryReceipt>{
 if(!token||token.length<32)throw Error('delivery_receiver_disabled');
 const expected=Buffer.from('Bearer '+token),actual=Buffer.from(authorization||'');
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('delivery_receiver_unauthenticated');
 const {providerResourceId,value,...binding}=input;validate(binding);
 if(typeof value!=='string'||!value.trim()||value.length>16384||typeof providerResourceId!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(providerResourceId))throw Error('delivery_input_invalid');
 const local=Object.freeze(structuredClone(binding));
 try{await ports.verifyLocalAuthority(local);await ports.consumeDeliveryIntent(local);}catch{throw Error('delivery_receiver_authority_denied');}
 try{await ports.store({...local,providerResourceId,value});return receipt(await ports.readback(local),local,providerResourceId);}catch{throw Error('delivery_receiver_outcome_unknown_no_replay');}
}
