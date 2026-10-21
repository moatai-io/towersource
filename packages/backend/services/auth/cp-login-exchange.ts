import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
export interface CpLoginIdentity {subjectId:string;organizationId:string;instanceId:string;role:'owner'|'admin'|'member';displayName:string;}
export interface CpLoginSessionPort {
 /** Transactional exact external identity mapping; never attach by email/username. */
 createSession(identity:CpLoginIdentity):Promise<string>;
}
export function cpLoginExchange(config:{cpOrigin:string;instanceId:string;organizationId:string;receiverToken:string},sessions:CpLoginSessionPort){
 const cp=new URL(config.cpOrigin);if(cp.protocol!=='https:'||cp.pathname!=='/'||cp.username||cp.password||cp.search||cp.hash||config.receiverToken.length<32)throw Error('cp_login_config_invalid');
 const opaque=/^[A-Za-z0-9_-]{43}$/;
 return {
  begin(){const verifier=randomBytes(32).toString('base64url'),state=randomBytes(32).toString('base64url');return {verifier,state,challenge:createHash('sha256').update(verifier).digest('base64url')};},
  async complete(input:{code:string;state:string;browserState:string;verifier:string}){
   if(![input.code,input.state,input.browserState,input.verifier].every(x=>opaque.test(x))||!timingSafeEqual(Buffer.from(input.state),Buffer.from(input.browserState)))throw Error('cp_login_browser_binding_invalid');
   const r=await fetch(new URL('/api/tower-login/exchange',cp),{method:'POST',headers:{Authorization:'Bearer '+config.receiverToken,'content-type':'application/json'},body:JSON.stringify({code:input.code,state:input.state,verifier:input.verifier}),redirect:'error',signal:AbortSignal.timeout(10000)});
   if(!r.ok)throw Error('cp_login_denied');const text=await r.text();if(text.length>8192)throw Error('cp_login_identity_invalid');const x=JSON.parse(text) as CpLoginIdentity;
   if(Object.keys(x).sort().join(',')!=='displayName,instanceId,organizationId,role,subjectId'||x.instanceId!==config.instanceId||x.organizationId!==config.organizationId||! /^[a-f0-9-]{36}$/.test(x.subjectId)||!['owner','admin','member'].includes(x.role)||typeof x.displayName!=='string'||!x.displayName.trim()||x.displayName.length>120)throw Error('cp_login_identity_invalid');
   return sessions.createSession(x);
  },
 };
}
