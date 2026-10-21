import {relayApprovedIssuance,type CentralRelayContract,type CentralRelayPorts} from './central-relay.js';
import {timingSafeEqual} from 'node:crypto';
import type {ApprovedDelivery} from './central-delivery.js';
export interface CentralRelayHttpConfig {
 serviceToken?:string;
 /** Reads a locally published approved contract. Remote requests cannot select primary/receiver/SSH/URL. */
 contractFor(approvalHash:string,providerKind:'zuplo'|'litellm'):Promise<CentralRelayContract>;
 ports:CentralRelayPorts;
}
/** Private relay endpoint core. Not mounted and not an SSH authority grant. */
export async function handleCentralRelayHttp(request:Request,config:CentralRelayHttpConfig):Promise<Response>{
 const reply=(status:number,body:object)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
 if(request.method!=='POST')return reply(405,{error:'method_not_allowed'});
 if(!config.serviceToken||config.serviceToken.length<32)return reply(503,{error:'central_relay_disabled'});
 const expected=Buffer.from('Bearer '+config.serviceToken),actual=Buffer.from(request.headers.get('authorization')||'');
 if(expected.length!==actual.length||!timingSafeEqual(expected,actual))return reply(401,{error:'central_relay_unauthenticated'});
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return reply(415,{error:'json_required'});
 let raw:ApprovedDelivery;
 try{
  if(!request.body)throw Error();const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const x=await reader.read();if(x.done)break;size+=x.value.byteLength;if(size>8192){await reader.cancel();return reply(413,{error:'input_too_large'});}chunks.push(x.value);}}finally{reader.releaseLock();}
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const keys=['intentId','customerId','instanceId','approvalHash','policyHash','providerKind','credentialId'];
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==keys.length||!keys.every(k=>Object.hasOwn(body,k))||typeof body.approvalHash!=='string'||!/^[a-f0-9]{64}$/.test(body.approvalHash)||!['zuplo','litellm'].includes(body.providerKind))throw Error();
  raw=body;
 }catch{return reply(400,{error:'invalid_input'});}
 let contract:CentralRelayContract;
 try{contract=await config.contractFor(raw.approvalHash,raw.providerKind);}catch{return reply(403,{error:'central_contract_unavailable'});}
 try{return reply(200,await relayApprovedIssuance(contract,raw,config.ports));}
 catch(e){const code=e instanceof Error?e.message:'';return reply(code==='central_relay_outcome_unknown_no_replay'||code==='central_relay_readback_unverified'?502:403,{error:code==='central_relay_outcome_unknown_no_replay'?'central_relay_outcome_unknown':'central_relay_unverified'});}
}
