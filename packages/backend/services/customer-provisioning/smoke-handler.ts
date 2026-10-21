import {authorizeCustomerService,isCustomerSmokeModel,type CustomerServiceAuthority} from './service-boundary.js';
export interface CustomerSmokeServicePorts {
 /** Reconcile durable response without executing another inference. */
 recover?(intentId:string,signal:AbortSignal,model?:string):Promise<boolean>;
 usage():Promise<{source:'litellm-team-usage';teamSpendMicrousd:number;smokeSpendMicrousd:number;smokeRequests:number;observedAt:string}>;
 estimate(input:{model:string;prompt:string}):Promise<number>;
 /** Must check current Team budget and reserve a conservative bound before the single provider request. */
 execute(input:{model:string;prompt:string;maxOutputTokens:number;intentId:string}):Promise<{requestId:string;model:string;usageMicrousd:number}>;
}
/** Local service contract only. No public route or concrete provider/Vault authority is enabled here. */
export async function handleCustomerSmokeService(request:Request,action:'usage'|'estimate'|'execute',config:{serviceToken?:string;authority:CustomerServiceAuthority;ports:CustomerSmokeServicePorts}):Promise<Response>{
 const reply=(status:number,body:object)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
 if(request.method!=='POST')return reply(405,{error:'method_not_allowed'});
 if(!config.serviceToken||config.serviceToken.length<32)return reply(503,{error:'customer_service_disabled'});
 const auth=request.headers.get('authorization');
 if(!auth||auth.length>4096)return reply(401,{error:'customer_service_unauthenticated'});
 if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return reply(415,{error:'json_required'});
 let raw:Record<string,unknown>;
 try{
  const reader=request.body?.getReader();if(!reader)throw Error();let size=0;const chunks:Uint8Array[]=[];
  try{for(;;){const x=await reader.read();if(x.done)break;size+=x.value.byteLength;if(size>8192){await reader.cancel();return reply(413,{error:'input_too_large'});}chunks.push(x.value);}}finally{reader.releaseLock();}
  const x=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!x||typeof x!=='object'||Array.isArray(x))throw Error();raw=x;
 }catch{return reply(400,{error:'invalid_input'});}
 const fields=action==='usage'?['customerId','instanceId','approvalHash']:action==='estimate'?['customerId','instanceId','approvalHash','model','prompt']:['customerId','instanceId','approvalHash','intentId','model','prompt','maxOutputTokens'];
 if(Object.keys(raw).length!==fields.length||fields.some(k=>!Object.hasOwn(raw,k)))return reply(400,{error:'invalid_input'});
 if(action!=='usage'&&(!isCustomerSmokeModel(raw.model)||raw.prompt!=='Reply with exactly: TOWER_SMOKE_OK'||(action==='execute'&&raw.maxOutputTokens!==32)))return reply(400,{error:'invalid_smoke_input'});
 try{
  await authorizeCustomerService({customerId:raw.customerId,instanceId:raw.instanceId,approvalHash:raw.approvalHash,operation:`smoke-${action}`,...(action!=='usage'?{model:raw.model}:{}),...(action==='execute'?{intentId:raw.intentId}:{})},auth,config.serviceToken,config.authority);
 }catch(e){const code=e instanceof Error?e.message:'';return reply(code==='customer_service_unauthenticated'?401:code==='customer_service_disabled'?503:403,{error:'customer_service_access_denied'});}
 try{
  if(action==='usage'){
   const x=await config.ports.usage();if(x.source!=='litellm-team-usage'||![x.teamSpendMicrousd,x.smokeSpendMicrousd,x.smokeRequests].every(v=>Number.isSafeInteger(v)&&v>=0)||!Number.isFinite(Date.parse(x.observedAt)))throw Error();
   return reply(200,{source:x.source,teamSpendMicrousd:x.teamSpendMicrousd,smokeSpendMicrousd:x.smokeSpendMicrousd,smokeRequests:x.smokeRequests,observedAt:x.observedAt});
  }
  const input={model:raw.model as string,prompt:raw.prompt as string};
  if(action==='estimate'){const n=await config.ports.estimate(input);if(!Number.isSafeInteger(n)||n<0||n>1000000)throw Error();return reply(200,{estimatedMicrousd:n});}
  const x=await config.ports.execute({...input,maxOutputTokens:32,intentId:raw.intentId as string});
  if(!/^[-A-Za-z0-9_:./=+]{1,2048}$/.test(x.requestId)||x.model!==input.model||!Number.isSafeInteger(x.usageMicrousd)||x.usageMicrousd<0||x.usageMicrousd>1000000)throw Error();
  return reply(200,{requestId:x.requestId,model:x.model,usageMicrousd:x.usageMicrousd});
 }catch{return reply(502,{error:action==='execute'?'customer_smoke_outcome_unknown':'customer_smoke_readback_unavailable'});}
}
