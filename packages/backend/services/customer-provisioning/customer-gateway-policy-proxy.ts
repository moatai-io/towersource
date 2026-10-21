export function customerGatewayPolicyProxy(config:{instanceId:string;endpoint:string;token:string},fetcher:typeof fetch=fetch){
 const u=new URL(config.endpoint);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||config.token.length<32||/[\r\n]/.test(config.token))throw Error('gateway_policy_proxy_invalid');
 return async(instanceId:string)=>{
  if(instanceId!==config.instanceId)throw Error('gateway_policy_proxy_target_denied');
  const r=await fetcher(u,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{authorization:'Bearer '+config.token}});if(!r.ok){await r.body?.cancel();throw Error('gateway_policy_proxy_failed');}
  const reader=r.body?.getReader();if(!reader)throw Error('gateway_policy_proxy_empty');let size=0;const parts:Uint8Array[]=[];try{while(true){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>32768)throw Error('gateway_policy_proxy_oversized');parts.push(x.value);}}finally{await reader.cancel();}
  const x=JSON.parse(Buffer.concat(parts).toString());if(!x||Object.keys(x).sort().join(',')!=='instanceId,observedAt,policy,revision'||x.instanceId!==instanceId||!Number.isFinite(Date.parse(x.observedAt))||Math.abs(Date.now()-Date.parse(x.observedAt))>60000||!/^[a-f0-9]{64}$/.test(x.revision)||!x.policy||Object.keys(x.policy).sort().join(',')!=='enabledApiIds,profileVersion,quotaMode'||typeof x.policy.profileVersion!=='string'||x.policy.quotaMode!=='observe'||!Array.isArray(x.policy.enabledApiIds)||!x.policy.enabledApiIds.length||x.policy.enabledApiIds.some((id:unknown)=>typeof id!=='string'))throw Error('gateway_policy_proxy_response_invalid');
  return {policy:x.policy as {profileVersion:string;enabledApiIds:string[];quotaMode:'observe'},revision:x.revision as string};
 };
}
