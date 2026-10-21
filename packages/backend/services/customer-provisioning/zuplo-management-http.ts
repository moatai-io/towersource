import type {ZuploManagementPort} from './zuplo-key-issuer.js';
/** Fixed Developer API origin; bounded GET discovery and single POST, never retries issuance. */
export function zuploManagementHttp(token:string,fetchImpl:typeof fetch=fetch):ZuploManagementPort & {readConsumer(account:string,bucket:string,name:string):Promise<{id:string;name:string;metadata:Record<string,unknown>}|null>}{
 if(typeof token!=='string'||token.length<16||/[\r\n]/.test(token))throw Error('zuplo_management_unconfigured');
 const segment=(x:string)=>{if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(x))throw Error('zuplo_identifier_invalid');return encodeURIComponent(x);};
 const base=(account:string,bucket:string)=>`https://dev.zuplo.com/v1/accounts/${segment(account)}/key-buckets/${segment(bucket)}/consumers`;
 async function request(url:string,body?:unknown){
  const r=await fetchImpl(url,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'User-Agent':'Tower-Customer-Provisioning/1.0',Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!r.ok){await r.body?.cancel();throw Error('zuplo_management_http_'+r.status);}
  const reader=r.body?.getReader();if(!reader)throw Error('zuplo_management_empty');let size=0;const chunks:Uint8Array[]=[];
  try{while(true){const x=await reader.read();if(x.done)break;size+=x.value.byteLength;if(size>1048576)throw Error('zuplo_management_oversized');chunks.push(x.value);}}finally{await reader.cancel();}
  try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw Error('zuplo_management_invalid_json');}
 }
 async function readConsumer(account:string,bucket:string,name:string){
  segment(name);let offset=0;let found:{id:string;name:string;metadata:Record<string,unknown>}|null=null;
  for(let page=0;page<100;page++){
   const r=await request(base(account,bucket)+`?offset=${offset}&limit=100`);
   if(!Array.isArray(r.data)||r.offset!==offset||!Number.isInteger(r.limit)||r.limit<1||r.limit>100||r.data.length>r.limit||r.data.some((x:any)=>typeof x?.name!=='string'))throw Error('zuplo_consumer_list_invalid');
   for(const x of r.data){if(x.name===name){if(found||typeof x.id!=='string'||!x.id)throw Error('zuplo_consumer_conflict');found={id:x.id,name:x.name,metadata:x.metadata??{}};}}
   if(r.data.length<r.limit)return found;offset+=r.data.length;
  }
  throw Error('zuplo_consumer_discovery_incomplete');
 }
 return {
  readConsumer,
  async consumerExists(account,bucket,name){return (await readConsumer(account,bucket,name))!==null;},
  async createConsumer(input){
   segment(input.name);
   const r=await request(base(input.account,input.bucketId)+'?with-api-key=true',{name:input.name,metadata:input.metadata});
   const c=r.data??r;return {id:c.id,name:c.name,apiKeys:c.apiKeys};
  }
 };
}
