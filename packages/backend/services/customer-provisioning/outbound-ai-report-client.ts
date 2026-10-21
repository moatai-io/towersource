/** Report transport only: caller loads an already reconciled local result.
 * No execution callback is accepted, so network retries cannot issue paid AI calls.
 */
export interface OutboundAiReport {executionHash:string;instanceId:string;model:'gpt-6.1-sol';verified:true;requestId:string;evidenceId:string;usageMicrousd:number;}
export function outboundAiReportClient(config:{baseUrl:string;credential:string;executionId:string;executionHash:string;instanceId:string},ports:{assertCurrent():Promise<void>;readResult():Promise<OutboundAiReport|null>},fetcher:typeof fetch=fetch){
 const base=new URL(config.baseUrl);
 if(base.protocol!=='https:'||base.pathname!=='/'||base.username||base.password||base.search||base.hash||!/^[-_A-Za-z0-9]{43}$/.test(config.credential)||!/^[a-f0-9-]{36}$/i.test(config.executionId)||!/^[a-f0-9-]{36}$/i.test(config.instanceId)||!/^[a-f0-9]{64}$/.test(config.executionHash))throw Error('outbound_report_config_invalid');
 return {async tick(signal:AbortSignal){
 signal.throwIfAborted();await ports.assertCurrent();const report=await ports.readResult();signal.throwIfAborted();
 if(!report)return {status:'waiting' as const};
 if(Object.keys(report).sort().join(',')!=='evidenceId,executionHash,instanceId,model,requestId,usageMicrousd,verified'||report.executionHash!==config.executionHash||report.instanceId!==config.instanceId||report.model!=='gpt-6.1-sol'||report.verified!==true||!/^[a-f0-9-]{36}$/i.test(report.evidenceId)||!/^[-A-Za-z0-9_:./=+]{1,2048}$/.test(report.requestId)||!Number.isSafeInteger(report.usageMicrousd)||report.usageMicrousd<0||report.usageMicrousd>1000000)throw Error('outbound_report_result_invalid');
 await ports.assertCurrent();signal.throwIfAborted();
 const response=await fetcher(new URL('/api/enrollment/ack',base),{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),headers:{authorization:'Bearer '+config.credential,'content-type':'application/json'},body:JSON.stringify({kind:'ai-result',executionId:config.executionId,report})});
 if(!response.ok){await response.body?.cancel();throw Error('outbound_report_request_failed');}
 const reader=response.body?.getReader();if(!reader)throw Error('outbound_report_empty');let size=0;const chunks:Uint8Array[]=[];
 try{for(;;){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>4096)throw Error('outbound_report_response_large');chunks.push(x.value);}}finally{await reader.cancel();}
 const body=JSON.parse(Buffer.concat(chunks).toString());if(body?.status!=='received'||body.verifiedByControlPlane!==false)throw Error('outbound_report_response_invalid');
 return {status:'received' as const,verifiedByControlPlane:false as const};
 }};
}
