import type {QuickReplyOpts} from '../../engines/types.js';
/** Explicit server-configured endpoint/auth only. Never accept these from model
 * output. No config.ts import or .env fallback. Owns no tools or session state. */
export function createGoalReviewProvider(config:{baseUrl:string;apiKey:string;model:string;
 timeoutMs?:number;maxBytes?:number;fetch?:typeof fetch}) {
 const endpoint=new URL(config.baseUrl);
 if(!['https:','http:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash
   ||!config.apiKey||!config.model.trim())throw new Error('INVALID_REVIEW_PROVIDER');
 const timeout=config.timeoutMs??30000;const max=config.maxBytes??200000;
 if(!Number.isInteger(timeout)||timeout<1||timeout>120000||!Number.isInteger(max)||max<1||max>1000000)throw new Error('INVALID_PROVIDER_LIMIT');
 const send=config.fetch??fetch;
 return async(prompt:string,opts:QuickReplyOpts,signal:AbortSignal):Promise<string>=>{
  signal.throwIfAborted();
  if(Buffer.byteLength(prompt)+Buffer.byteLength(opts.systemPrompt)>max)throw new Error('REVIEW_INPUT_LIMIT');
  const response=await send(endpoint.toString().replace(/\/$/,'')+'/responses',{
   method:'POST',signal:AbortSignal.any([signal,AbortSignal.timeout(timeout)]),
   headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.apiKey}`},
   body:JSON.stringify({model:config.model,max_output_tokens:2048,input:[{role:'system',content:opts.systemPrompt},{role:'user',content:prompt}]}),
  });
  if(!response.ok){await response.body?.cancel();throw new Error(`REVIEW_PROVIDER_HTTP_${response.status}`);}
  if(!response.body)throw new Error('REVIEW_EMPTY_RESPONSE');
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try{
   for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;
    size+=value.length;if(size>max)throw new Error('REVIEW_OUTPUT_LIMIT');chunks.push(value);}
  }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  signal.throwIfAborted();
  let data:any;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('REVIEW_INVALID_RESPONSE');}
  if(data.status && data.status!=='completed')throw new Error('REVIEW_INCOMPLETE_RESPONSE');
  const text=typeof data.output_text==='string'?data.output_text:
   (Array.isArray(data.output)?data.output:[]).filter((x:any)=>x.type==='message'&&x.role==='assistant')
   .flatMap((x:any)=>Array.isArray(x.content)?x.content:[]).filter((x:any)=>x.type==='output_text'&&typeof x.text==='string').map((x:any)=>x.text).join('');
  if(!text.trim())throw new Error('REVIEW_EMPTY_RESPONSE');
  opts.onChunk(text,text);return text;
 };
}
