import type {LiteLlmManagementPort} from './litellm-key-issuer.js';
/** Container-local management only; never a caller-selected remote endpoint. Secrets stay in this closure. */
export function localLiteLlmManagement(config:{baseUrl:string;masterKey:string;timeoutMs?:number;installedDockerOrigin?:string}):LiteLlmManagementPort {
 const base=new URL(config.baseUrl);
 const docker=config.installedDockerOrigin;
 const dockerAllowed=typeof docker==='string'&&/^http:\/\/[a-z][a-z0-9-]{0,62}:[0-9]{1,5}$/.test(docker)&&base.origin===docker;
 if(docker!==undefined&&!dockerAllowed)throw Error('litellm_management_config_invalid');
 if(base.protocol!=='http:'||(!['127.0.0.1','[::1]'].includes(base.hostname)&&!dockerAllowed)||base.username||base.password||base.search||base.hash||base.pathname!=='/'||config.masterKey.length<32)throw Error('litellm_management_config_invalid');
 const timeout=config.timeoutMs??10000;if(!Number.isInteger(timeout)||timeout<100||timeout>30000)throw Error('litellm_management_config_invalid');
 const allowed=new Map([['/models','GET'],['/team/list','GET'],['/team/info','GET'],['/key/list','GET'],['/team/new','POST'],['/key/generate','POST']]);
 return {async request(path,method,body){
  const u=new URL(path,base);
  if(u.origin!==base.origin||allowed.get(u.pathname)!==method||u.hash||u.username||u.password||(method==='GET'&&body!==undefined))throw Error('litellm_management_operation_denied');
  const queryKeys=[...u.searchParams.keys()];
  const expectedQuery=u.pathname==='/team/info'?['team_id']:u.pathname==='/key/list'?['team_id','page','size','return_full_object']:[];
  if(method==='POST'&&queryKeys.length||method==='GET'&&(queryKeys.length!==expectedQuery.length||expectedQuery.some(k=>!u.searchParams.get(k))||queryKeys.some(k=>!expectedQuery.includes(k))))throw Error('litellm_management_operation_denied');
  if(u.pathname==='/key/list'&&(u.searchParams.get('page')!=='1'||u.searchParams.get('size')!=='100'||u.searchParams.get('return_full_object')!=='true'))throw Error('litellm_management_operation_denied');
  const signal=AbortSignal.timeout(timeout);let response:Response;
  try{response=await fetch(u,{method,headers:{authorization:'Bearer '+config.masterKey,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal});}catch{throw Error('litellm_management_transport_unknown');}
  if(!response.ok){await response.body?.cancel();throw Error('litellm_management_request_failed');}
  const reader=response.body?.getReader();if(!reader)throw Error('litellm_management_response_invalid');
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const x=await reader.read();if(x.done)break;size+=x.value.byteLength;if(size>262144){await reader.cancel();throw Error('litellm_management_response_invalid');}chunks.push(x.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}
  catch{throw Error('litellm_management_response_invalid');}finally{reader.releaseLock();}
 }};
}
