export interface OutboundDelivery {
 status:'available';deliveryId:string;providerResourceId:string;value:string;
 binding:{organizationId:string;instanceId:string;executionId:string;intentId:string;deliveryId:string;provider:'zuplo'|'litellm';policyHash:string;expiresAt:string};
}
export interface OutboundStoredReceipt {deliveryId:string;instanceId:string;executionId:string;intentId:string;provider:'zuplo'|'litellm';policyHash:string;providerResourceId:string;stored:true;}
export interface OutboundClientPorts {
 /** Approved local policy and Vault ACL check; not just identity shape. */
 authorize(delivery:Readonly<OutboundDelivery>):Promise<void>;
 readStored(delivery:Readonly<OutboundDelivery>):Promise<OutboundStoredReceipt|null>;
 storeAndVerify(delivery:Readonly<OutboundDelivery>):Promise<OutboundStoredReceipt>;
}
/** Single client turn; no inbound listener, no timer, no automatic provider issuance.
 * Caller persists machine credential before bootstrap and controls bounded polling.
 */
export function outboundEnrollmentClient(config:{baseUrl:string;credential:string;instanceId:string;organizationId:string},ports:OutboundClientPorts,fetcher:typeof fetch=fetch){
 const base=new URL(config.baseUrl);if(base.protocol!=='https:'||base.username||base.password||base.hash||base.search||base.pathname!=='/'||!/^[-_A-Za-z0-9]{43}$/.test(config.credential))throw Error('outbound_client_config_invalid');
 async function call(action:'next'|'ack',body:object,signal:AbortSignal){const r=await fetcher(new URL('/api/enrollment/'+action,base),{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),headers:{authorization:'Bearer '+config.credential,'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok){await r.body?.cancel();throw Error(r.status===401||r.status===403?'outbound_delivery_auth_denied':'outbound_delivery_request_failed');}const reader=r.body?.getReader();if(!reader)throw Error('outbound_delivery_empty');let size=0;const chunks:Uint8Array[]=[];try{while(true){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>32768)throw Error('outbound_delivery_large');chunks.push(x.value);}}finally{await reader.cancel();}return JSON.parse(Buffer.concat(chunks).toString());}
 function checkReceipt(d:OutboundDelivery,r:OutboundStoredReceipt){if(!r||Object.keys(r).length!==8||r.stored!==true||r.providerResourceId!==d.providerResourceId||(['deliveryId','instanceId','executionId','intentId','provider','policyHash'] as const).some(k=>r[k]!==d.binding[k]))throw Error('outbound_stored_receipt_mismatch');}
 return {async tick(signal:AbortSignal){
  const x=await call('next',{},signal);if(x?.status==='idle'&&Object.keys(x).length===1)return {status:'idle' as const};
  const d=x as OutboundDelivery;if(!d||d.status!=='available'||!d.binding||d.deliveryId!==d.binding.deliveryId||d.binding.instanceId!==config.instanceId||d.binding.organizationId!==config.organizationId||!['zuplo','litellm'].includes(d.binding.provider)||!/^[a-f0-9]{64}$/.test(d.binding.policyHash)||!Number.isFinite(Date.parse(d.binding.expiresAt))||Date.parse(d.binding.expiresAt)<=Date.now()||typeof d.value!=='string'||!d.value||Buffer.byteLength(d.value)>16384||typeof d.providerResourceId!=='string'||!d.providerResourceId)throw Error('outbound_delivery_binding_invalid');
  signal.throwIfAborted();await ports.authorize(d);const existing=await ports.readStored(d);const receipt=existing??await ports.storeAndVerify(d);checkReceipt(d,receipt);
  signal.throwIfAborted();await ports.authorize(d);const ack=await call('ack',{deliveryId:d.deliveryId,receipt},signal);checkReceipt(d,ack);
  return {status:'acknowledged' as const,deliveryId:d.deliveryId,reused:existing!==null};
 }};
}
