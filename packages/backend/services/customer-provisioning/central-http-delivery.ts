import type {ApprovedDelivery,CentralIssuancePorts,DeliveryReceipt} from './central-delivery.js';

export interface CustomerDeliveryTransportConfig {
 /** Selected and attested by the central authority BEFORE any key is issued. */
 baseUrl:string;serviceToken:string;timeoutMs?:number;
 allowLoopbackForTests?:boolean;
}
export function customerDeliveryTransport(config:CustomerDeliveryTransportConfig):Pick<CentralIssuancePorts,'deliver'|'readback'> & {preflight(input:ApprovedDelivery):Promise<void>}{
 const frozen=Object.freeze({...config});let base:URL;
 try{base=new URL(frozen.baseUrl);}catch{throw Error('customer_delivery_transport_config_invalid');}
 const loopback=frozen.allowLoopbackForTests===true&&base.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(base.hostname);
 if(base.username||base.password||base.search||base.hash||!['/','/_provision/zuplo','/_provision/zuplo/','/_provision/litellm','/_provision/litellm/'].includes(base.pathname)||(base.protocol!=='https:'&&!loopback)||typeof frozen.serviceToken!=='string'||frozen.serviceToken.length<32||/[\r\n]/.test(frozen.serviceToken))throw Error('customer_delivery_transport_config_invalid');
 const timeout=frozen.timeoutMs??15000;
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>60000)throw Error('customer_delivery_transport_config_invalid');
 async function call(input:ApprovedDelivery & {providerResourceId?:string;value?:string},store:boolean,preflight=false):Promise<DeliveryReceipt>{
  const prefix=base.pathname.replace(/\/$/,'');
  if(prefix&&prefix!=='/_provision/'+input.providerKind)throw Error('customer_delivery_provider_path_mismatch');
  let response:Response;
  try{response=await fetch(new URL(prefix+(preflight?'/v1/credentials/preflight':store?'/v1/credentials/deliver':'/v1/credentials/readback'),base),{method:'POST',redirect:'error',headers:{authorization:'Bearer '+frozen.serviceToken,'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(timeout)});}catch{throw Error('customer_delivery_transport_outcome_unknown');}
  if(!response.ok){await response.body?.cancel().catch(()=>undefined);throw Error('customer_delivery_transport_outcome_unknown');}
  let raw:unknown;
  try{
   const reader=response.body?.getReader();if(!reader)throw Error();let bytes=0;const chunks:Uint8Array[]=[];
   try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>8192){await reader.cancel();throw Error();}chunks.push(next.value);}}finally{reader.releaseLock();}
   raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch{throw Error('customer_delivery_transport_readback_unverified');}
  if(preflight){
   const x=raw as ApprovedDelivery & {ready:true};
   if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).length!==8||x.ready!==true||Object.keys(input).some(k=>x[k as keyof ApprovedDelivery]!==input[k as keyof ApprovedDelivery]))throw Error('customer_delivery_preflight_unverified');
   return x as unknown as DeliveryReceipt;
  }
  const x=raw as DeliveryReceipt;
  if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).length!==9||['intentId','customerId','instanceId','approvalHash','policyHash','providerKind','credentialId'].some(k=>x[k as keyof ApprovedDelivery]!==input[k as keyof ApprovedDelivery])||x.stored!==true||typeof x.providerResourceId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(x.providerResourceId)||(store&&x.providerResourceId!==input.providerResourceId))throw Error('customer_delivery_transport_readback_unverified');
  // Only the exact secret-free receipt leaves this port.
  return x;
 }
 return {deliver:input=>call(input,true),readback:input=>call(input,false),preflight:async input=>{await call(input,false,true);}};
}
