import {useEffect,useState} from 'react';
export interface OwnDisplayIdentity {id:number;username:string;displayName:string;}
let currentRequest:{token:string;startedAt:number;promise:Promise<unknown>}|null=null;
function ownProfile(token:string):Promise<unknown>{
 if(currentRequest?.token===token&&Date.now()-currentRequest.startedAt<30000)return currentRequest.promise;
 const promise=fetch('/api/me',{headers:{Authorization:`Bearer ${token}`},cache:'no-store'}).then(async r=>r.ok?r.json():null).catch(()=>null);
 currentRequest={token,startedAt:Date.now(),promise};return promise;
}
/** A display hint, never an authorization identity. Only the current credential has a short-lived deduplicated request. */
export function useOwnDisplayIdentity(enabled=true):OwnDisplayIdentity|null {
 const token=!enabled||typeof localStorage==='undefined'?null:localStorage.getItem('token');
 const [value,setValue]=useState<{token:string;identity:OwnDisplayIdentity}|null>(null);
 useEffect(()=>{if(!token){setValue(null);return;}const controller=new AbortController();
 void ownProfile(token).then((data)=>{
  const p=data as any;if(!p)return;

  if(controller.signal.aborted||localStorage.getItem('token')!==token||!Number.isSafeInteger(p.id)||typeof p.username!=='string')return;
  const name=typeof p.display_name==='string'?p.display_name.trim():'';
  if(name)setValue({token,identity:{id:p.id,username:p.username,displayName:name}});
 }).catch(()=>{});return()=>controller.abort();
 },[token]);
 return value?.token===token?value.identity:null;
}
export function visibleSpeakerName(username:string|undefined,own:OwnDisplayIdentity|null):string|undefined {
 return own&&username===own.username?own.displayName:username;
}
