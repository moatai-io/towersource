import {open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {centralRelayContractHash,type CentralRelayContract} from './central-relay.js';
import {customerDeliveryTransport,type CustomerDeliveryTransportConfig} from './central-http-delivery.js';
import type {ApprovedDelivery} from './central-delivery.js';
/** Root-published selection, not a request-provided runtime identity. No secrets in this file.
 * Root/operator updates this selection when primary routing or deployed revision changes.
 * Receiver preflight independently checks its current DB authority and Vault absence.
 */
export function installedCentralAttestation(file:string){
 if(!path.isAbsolute(file)||file.split('/').includes('..'))throw Error('central_attestation_path_invalid');
 async function selected(){
  for(let p=path.dirname(file);;p=path.dirname(p)){
   const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)!==0)throw Error('central_attestation_unprotected');
   if(p===path.dirname(p))break;
  }
  const h=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const s=await h.stat();if(!s.isFile()||s.uid!==0||(s.mode&0o022)!==0||s.size>16384)throw Error('central_attestation_unprotected');
   const bytes=Buffer.alloc(16385);const n=(await h.read(bytes,0,bytes.length,0)).bytesRead;if(n>16384)throw Error('central_attestation_invalid');
   const x=JSON.parse(bytes.subarray(0,n).toString());
   if(x?.schemaVersion!==1||x.revoked!==false||!Number.isFinite(Date.parse(x.expiresAt))||Date.parse(x.expiresAt)<=Date.now()||!Array.isArray(x.contracts)||x.contracts.length>32)throw Error('central_attestation_invalid');
   return x;
  }finally{await h.close();}
 }
 async function match(contract:Readonly<CentralRelayContract>){
  const s=await selected();const hash=centralRelayContractHash(contract);
  if(s.issuerRuntimeId!==contract.issuerRuntimeId||s.revision!==contract.revision)throw Error('central_attestation_runtime_mismatch');
  const row=s.contracts.find((r:any)=>r.contractHash===hash);
  if(!row||row.receiverRuntimeId!==contract.receiverRuntimeId)throw Error('central_attestation_contract_denied');
  return row as {contractHash:string;receiverRuntimeId:string;receiverBaseUrl:string};
 }
 return {
  async attest(contract:Readonly<CentralRelayContract>){await match(contract);},
  async verifyReceiver(contract:Readonly<CentralRelayContract>,input:ApprovedDelivery,receiver:CustomerDeliveryTransportConfig){
   const row=await match(contract);
   for(const k of ['customerId','instanceId','approvalHash','policyHash','providerKind','credentialId'] as const)if(contract[k]!==input[k])throw Error('central_attestation_delivery_mismatch');
   if(receiver.baseUrl!==row.receiverBaseUrl||receiver.allowLoopbackForTests)throw Error('central_attestation_receiver_mismatch');
   // Authenticated endpoint verifies installed policy, local instance, ACL, current intent and Vault absence.
   await customerDeliveryTransport(receiver).preflight(input);
   await match(contract);
  }
 };
}
