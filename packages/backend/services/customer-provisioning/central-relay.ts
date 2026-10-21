import {createHash} from 'node:crypto';
import type {ApprovedDelivery,DeliveryReceipt} from './central-delivery.js';
export interface CentralRelayContract {
 authorityId:string;revision:string;issuerRuntimeId:string;receiverRuntimeId:string;
 customerId:string;instanceId:string;approvalHash:string;policyHash:string;providerKind:'zuplo'|'litellm';credentialId:string;
}
export interface CentralRelayPorts {
 /** Exact contract must already exist in durable approval state; relay input does not publish it. */
 authorizeContract(hash:string,input:ApprovedDelivery):Promise<void>;
 /** Must verify currently selected primary, exact issuer and attested receiver independently. */
 attest(contract:Readonly<CentralRelayContract>):Promise<void>;
 consumeRelayIntent(hash:string,input:ApprovedDelivery):Promise<void>;
 /** Supported authenticated transport. No SSH target, shell/module path or management secret is caller-selectable. */
 issueAndDeliver(contract:Readonly<CentralRelayContract>,input:Readonly<ApprovedDelivery>):Promise<DeliveryReceipt>;
}
const id=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,hash=/^[a-f0-9]{64}$/;
export function centralRelayContractHash(raw:CentralRelayContract):string{
 const fields=['authorityId','revision','issuerRuntimeId','receiverRuntimeId','customerId','instanceId','approvalHash','policyHash','providerKind','credentialId'];
 if(!raw||Object.keys(raw).length!==fields.length||!fields.every(k=>Object.hasOwn(raw,k))||![raw.authorityId,raw.issuerRuntimeId,raw.receiverRuntimeId,raw.customerId,raw.credentialId].every(x=>typeof x==='string'&&id.test(x))||!uuid.test(raw.instanceId)||!hash.test(raw.approvalHash)||!hash.test(raw.policyHash)||! /^[a-f0-9]{40,64}$/.test(raw.revision)||!['zuplo','litellm'].includes(raw.providerKind))throw Error('central_relay_contract_invalid');
 return createHash('sha256').update(JSON.stringify({domain:'tower-central-relay-v1',...Object.fromEntries(fields.sort().map(k=>[k,raw[k as keyof CentralRelayContract]]))})).digest('hex');
}
export async function relayApprovedIssuance(raw:CentralRelayContract,input:ApprovedDelivery,ports:CentralRelayPorts):Promise<DeliveryReceipt>{
 const contractHash=centralRelayContractHash(raw),contract=Object.freeze(structuredClone(raw)),request=Object.freeze(structuredClone(input));
 if(!uuid.test(request.intentId)||Object.keys(request).length!==7||['customerId','instanceId','approvalHash','policyHash','providerKind','credentialId'].some(k=>request[k as keyof ApprovedDelivery]!==contract[k as keyof CentralRelayContract]))throw Error('central_relay_request_mismatch');
 try{await ports.authorizeContract(contractHash,request);await ports.attest(contract);await ports.consumeRelayIntent(contractHash,request);}catch{throw Error('central_relay_authority_denied');}
 let x:DeliveryReceipt;
 try{x=await ports.issueAndDeliver(contract,request);}catch{throw Error('central_relay_outcome_unknown_no_replay');}
 if(!x||Object.keys(x).length!==9||Object.keys(request).some(k=>x[k as keyof ApprovedDelivery]!==request[k as keyof ApprovedDelivery])||x.stored!==true||typeof x.providerResourceId!=='string'||!id.test(x.providerResourceId))throw Error('central_relay_readback_unverified');
 return {...request,providerResourceId:x.providerResourceId,stored:true};
}
