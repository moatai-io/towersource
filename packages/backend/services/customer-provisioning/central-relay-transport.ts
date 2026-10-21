import type {ApprovedDelivery,DeliveryReceipt} from './central-delivery.js';
import type {CentralRelayContract} from './central-relay.js';
export interface CentralRelayTransportConfig {
 /** Deployment-selected private HTTPS endpoint, never selected from caller input. */
 endpoint:string;serviceToken:string;contractHash:string;timeoutMs?:number;
}
/** Sends only approved intent fields, receives only a secret-free receipt. No arbitrary remote shell capability. */
export function centralRelayTransport(config:CentralRelayTransportConfig,fetcher:typeof fetch=fetch){
 const url=new URL(config.endpoint);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||config.serviceToken.length<32||!/^[a-f0-9]{64}$/.test(config.contractHash)||!Number.isInteger(config.timeoutMs??15000)||(config.timeoutMs??15000)<100||(config.timeoutMs??15000)>60000)throw Error('central_transport_config_invalid');
 return async(contract:Readonly<CentralRelayContract>,input:Readonly<ApprovedDelivery>):Promise<DeliveryReceipt>=>{
  const {centralRelayContractHash}=await import('./central-relay.js');
  if(centralRelayContractHash(contract)!==config.contractHash)throw Error('central_transport_contract_mismatch');
  let r:Response;
  try{r=await fetcher(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(config.timeoutMs??15000),headers:{authorization:'Bearer '+config.serviceToken,'content-type':'application/json',accept:'application/json'},body:JSON.stringify(input)});}catch{throw Error('central_transport_outcome_unknown_no_replay');}
  if(!r.ok||!r.body){await r.body?.cancel();throw Error('central_transport_unverified_no_replay');}
  const reader=r.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const x=await reader.read();if(x.done)break;size+=x.value.byteLength;if(size>16384){await reader.cancel();throw Error();}chunks.push(x.value);}}
  catch{throw Error('central_transport_unverified_no_replay');}finally{reader.releaseLock();}
  let x:Record<string,unknown>;
  try{x=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('central_transport_unverified_no_replay');}
  const keys=['intentId','customerId','instanceId','approvalHash','policyHash','providerKind','credentialId','providerResourceId','stored'];
  if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).length!==keys.length||!keys.every(k=>Object.hasOwn(x,k))||keys.slice(0,7).some(k=>x[k]!==input[k as keyof ApprovedDelivery])||x.stored!==true||typeof x.providerResourceId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(x.providerResourceId))throw Error('central_transport_unverified_no_replay');
  return x as unknown as DeliveryReceipt;
 };
}
