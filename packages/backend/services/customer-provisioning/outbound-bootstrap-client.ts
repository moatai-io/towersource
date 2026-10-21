export async function redeemOutboundBootstrap(config:{baseUrl:string;bootstrapToken:string;credential:string;organizationId:string;instanceId:string},signal:AbortSignal,fetcher:typeof fetch=fetch){
 const u=new URL(config.baseUrl);if(u.protocol!=='https:'||u.pathname!=='/'||u.username||u.password||u.search||u.hash)throw Error('outbound_bootstrap_config_invalid');
 for(const value of [config.bootstrapToken,config.credential])if(!/^[A-Za-z0-9_-]{43}$/.test(value)||Buffer.from(value,'base64url').toString('base64url')!==value)throw Error('outbound_bootstrap_config_invalid');
 signal.throwIfAborted();const response=await fetcher(new URL('/api/enrollment/bootstrap',u),{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),headers:{authorization:'Bearer '+config.bootstrapToken,'content-type':'application/json'},body:JSON.stringify({machineCredential:config.credential})});
 if(!response.ok){await response.body?.cancel();throw Error('outbound_bootstrap_denied');}
 const reader=response.body?.getReader();if(!reader)throw Error('outbound_bootstrap_empty');const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>4096)throw Error('outbound_bootstrap_oversized');chunks.push(x.value);}}finally{await reader.cancel();}
 const result=JSON.parse(Buffer.concat(chunks).toString());if(result.organizationId!==config.organizationId||result.instanceId!==config.instanceId)throw Error('outbound_bootstrap_identity_mismatch');
 return {registered:true as const};
}
