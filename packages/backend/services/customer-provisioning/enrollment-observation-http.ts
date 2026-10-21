import {timingSafeEqual} from 'node:crypto';
export interface ApprovedObservationTarget {customerId:string;instanceId:string;proposalHash:string;providerKind:'zuplo'|'litellm';}
/** Deployment-bound read-only endpoint. Reader must independently inspect provider or local Vault.
 * A read failure is 503, never a synthetic absent response. */
export function enrollmentObservationHttp(config:{token:string;kind:'provider'|'vault';targets:readonly ApprovedObservationTarget[];read(target:Readonly<ApprovedObservationTarget>):Promise<Record<string,unknown>|null>}){
 if(!['provider','vault'].includes(config.kind)||config.token.length<32||!config.targets.length||typeof config.read!=='function')throw Error('observation_config_invalid');const targets=structuredClone(config.targets);
 return async(req:Request):Promise<Response>=>{
  const headers={'cache-control':'no-store'};const deny=(status:number)=>Response.json({error:'observation_denied'},{status,headers});
  const actual=Buffer.from(req.headers.get('authorization')??''),expected=Buffer.from('Bearer '+config.token);
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return deny(401);
  if(req.method!=='POST')return deny(405);
  try{const reader=req.body?.getReader();if(!reader)return deny(400);let size=0;const parts:Uint8Array[]=[];
   try{while(true){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>8192)return deny(413);parts.push(x.value);}}finally{await reader.cancel();}
   let input:any;try{input=JSON.parse(Buffer.concat(parts).toString());}catch{return deny(400);}
   if(!input||Object.keys(input).sort().join(',')!=='customerId,instanceId,proposalHash,providerKind')return deny(400);
   const target=targets.find(t=>Object.keys(t).every(k=>t[k as keyof ApprovedObservationTarget]===input[k]));if(!target)return deny(403);
   const record=await config.read(Object.freeze({...target}));
   if(record!==null&&(typeof record!=='object'||Array.isArray(record)))return deny(503);
   if(record!==null){const fields=config.kind==='provider'?['resourceId','providerKind','providerIdentity','accountOrTeamScope','policy','registryRevision']:['targetInstanceId','credentialId','providerKind','providerResourceId','policyHash','registryRevision'];if(Object.keys(record).length!==fields.length||fields.some(k=>!Object.hasOwn(record,k)))return deny(503);}
   return Response.json({customerId:target.customerId,instanceId:target.instanceId,proposalHash:target.proposalHash,observedAt:new Date().toISOString(),status:record===null?'absent':'present',record},{headers});
  }catch{return deny(503);}
 };
}
