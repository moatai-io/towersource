import {isCustomerSmokeModel} from './service-boundary.js';
import {resolveLiteLLMCredentials} from '../ai/litellm-credentials.js';
import {fetchLiteLLMSelfServiceUsage} from '../ai-usage/litellm-usage-client.js';
import {fetchLiteLLMTurnSpend} from '../ai-usage/litellm-turn-spend-client.js';
import type {CustomerSmokeServicePorts} from './smoke-handler.js';
export interface CustomerSmokeLedger {
 loadResponse?(intentId:string):Promise<{requestId:string;model:string;sentinel:string}|null>;
 snapshot():Promise<{spendMicrousd:number;requests:number}>;
 /** Persist provider-observed Team spend for the subsequent atomic budget reservation. */
 observeTeam?(spendMicrousd:number,observedAt:string):Promise<void>;
 /** Explicit conservative model/input pricing; unknown price is an error, never zero. */
 estimate(input:{model:string;prompt:string;maxOutputTokens:number}):Promise<number>;
 /** Atomic local Team/smoke reservation and current approval fence. Unknown request keeps reservation held. */
 reserve(intentId:string,estimatedMicrousd:number):Promise<void>;
 reconcile(intentId:string,requestId:string,actualMicrousd:number):Promise<void>;
 /** Persist validated response identity before querying asynchronous spend. */
 recordResponse?(intentId:string,response:{requestId:string;model:string;sentinel:string}):Promise<void>;
}
export function decimalUsdToMicrousd(raw:unknown):number{
 const text=typeof raw==='number'?String(raw):raw;
 if(typeof text!=='string'||! /^(0|[1-9]\d*)(\.\d{1,8})?$/.test(text))throw Error('customer_spend_invalid');
 const [whole,fraction='']=text.split('.');
 const value=BigInt(whole)*1000000n+BigInt((fraction+'000000').slice(0,6))+(fraction.slice(6).match(/[1-9]/)?1n:0n);
 if(value>BigInt(Number.MAX_SAFE_INTEGER))throw Error('customer_spend_invalid');return Number(value);
}
async function boundedJson(r:Response){
 if(!r.ok||!r.body)throw Error('customer_provider_response_invalid');const reader=r.body.getReader();const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const x=await reader.read();if(x.done)break;size+=x.value.byteLength;if(size>262144){await reader.cancel();throw Error('customer_provider_response_invalid');}chunks.push(x.value);}}finally{reader.releaseLock();}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>;}catch{throw Error('customer_provider_response_invalid');}
}
export function verifiedSmokeResponse(x:Record<string,any>,model:string):string {
   if(typeof x.id!=='string'||!/^[-A-Za-z0-9_:./=+]{1,2048}$/.test(x.id)||x.model!==model||x.status!=='completed')throw Error('customer_smoke_response_unverified');
   // A completed provider envelope alone is not evidence that AI produced the requested answer.
   if(!Array.isArray(x.output)||x.output.length<1)throw Error('customer_smoke_response_unverified');
   const texts:string[]=[];
   for(const item of x.output){
    if(!item||typeof item!=='object')throw Error('customer_smoke_response_unverified');
    if(item.type==='message'){
     if(item.role!=='assistant'||!Array.isArray(item.content))throw Error('customer_smoke_response_unverified');
     for(const content of item.content){
      if(!content||content.type!=='output_text'||typeof content.text!=='string')throw Error('customer_smoke_response_unverified');
      texts.push(content.text);
     }
    }else if(item.type!=='reasoning')throw Error('customer_smoke_response_unverified');
   }
   if(texts.join('').trim()!=='TOWER_SMOKE_OK')throw Error('customer_smoke_response_unverified');
 return x.id as string;
}
/** Canonical customer virtual-key resolution; management/master keys are not accepted by this interface. */
export function customerLiteLlmSmokePorts(ledger:CustomerSmokeLedger,deps={credentials:resolveLiteLLMCredentials,usage:fetchLiteLLMSelfServiceUsage,turnSpend:fetchLiteLLMTurnSpend,fetch:globalThis.fetch},now:()=>number=Date.now):CustomerSmokeServicePorts{
 return {
  async recover(intentId:string,signal:AbortSignal,model?:string){
   signal.throwIfAborted();const saved=await ledger.loadResponse?.(intentId);if(!saved)return false;
   if(!isCustomerSmokeModel(model)||saved.model!==model||saved.sentinel!=='TOWER_SMOKE_OK')throw Error('customer_smoke_response_unverified');
   const rows=await deps.turnSpend(intentId,signal);signal.throwIfAborted();
   if(rows.length!==1||rows[0].requestId!==saved.requestId||rows[0].rootTurnId!==intentId||rows[0].status!=='success')throw Error('customer_smoke_spend_unverified');
   const actual=decimalUsdToMicrousd(rows[0].spend);await ledger.reconcile(intentId,saved.requestId,actual);return true;
  },
  async usage(){
   const x=await deps.usage({scope:'team',period:'calendar_month',days:30,signal:AbortSignal.timeout(8000)});
   // A client-side fetch timestamp cannot establish provider accounting freshness.
   if(x.budget_observation?.source!=='litellm-team-budget')throw Error('customer_usage_budget_unverified');
   const observedAt=x.budget_observation.observed_at;
   if(typeof observedAt!=='string'||!Number.isFinite(Date.parse(observedAt))||now()-Date.parse(observedAt)<0||now()-Date.parse(observedAt)>60000)throw Error('customer_usage_freshness_unverified');
   const teamSpendMicrousd=decimalUsdToMicrousd(x.budget_observation.spend_usd);
   await ledger.observeTeam?.(teamSpendMicrousd,observedAt);
   const smoke=await ledger.snapshot();if(!Number.isSafeInteger(smoke.spendMicrousd)||smoke.spendMicrousd<0||!Number.isSafeInteger(smoke.requests)||smoke.requests<0)throw Error('customer_smoke_ledger_invalid');
   return {source:'litellm-team-usage',teamSpendMicrousd:decimalUsdToMicrousd(x.budget_observation.spend_usd),smokeSpendMicrousd:smoke.spendMicrousd,smokeRequests:smoke.requests,observedAt};
  },
  async estimate(input){const n=await ledger.estimate({...input,maxOutputTokens:32});if(!Number.isSafeInteger(n)||n<=0||n>1000000)throw Error('customer_smoke_price_unverified');return n;},
  async execute(input){
   if(!isCustomerSmokeModel(input.model)||input.prompt!=='Reply with exactly: TOWER_SMOKE_OK'||input.maxOutputTokens!==32)throw Error('customer_smoke_input_invalid');
   const n=await ledger.estimate(input);if(!Number.isSafeInteger(n)||n<=0||n>1000000)throw Error('customer_smoke_price_unverified');
   const credentials=await deps.credentials(),base=new URL(credentials.baseUrl);
   if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw Error('customer_smoke_endpoint_invalid');
   await ledger.reserve(input.intentId,n);
   // Exactly one paid request. No retry or reservation release after an ambiguous outcome.
   let r:Response;try{r=await deps.fetch(credentials.baseUrl.replace(/\/$/,'')+'/responses',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${credentials.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:input.model,max_output_tokens:32,input:[{role:'user',content:input.prompt}],metadata:{tower_root_turn_id:input.intentId},litellm_metadata:{spend_logs_metadata:{tower_root_turn_id:input.intentId}}})});}catch{throw Error('customer_smoke_outcome_unknown');}
   const x=await boundedJson(r);
   verifiedSmokeResponse(x,input.model);
   await ledger.recordResponse?.(input.intentId,{requestId:x.id as string,model:input.model,sentinel:'TOWER_SMOKE_OK'});
   const rows=await deps.turnSpend(input.intentId,AbortSignal.timeout(8000));
   if(rows.length!==1||rows[0].requestId!==x.id||rows[0].rootTurnId!==input.intentId||rows[0].status!=='success')throw Error('customer_smoke_spend_unverified');
   const actual=decimalUsdToMicrousd(rows[0].spend);if(actual>n)throw Error('customer_smoke_price_bound_exceeded');
   await ledger.reconcile(input.intentId,x.id,actual);return {requestId:x.id,model:input.model,usageMicrousd:actual};
  },
 };
}
