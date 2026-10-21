import type {Request,Response} from 'express';
import {verifyToken,getUserAuthState} from './auth.js';
/** Same-origin cookie-to-existing-browser-session bridge; no new token issuance. */
export function cpBrowserSession(origin:string){return async(req:Request,res:Response)=>{
 res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
 if(req.headers.origin!==origin)return res.sendStatus(403);
 const values=(req.headers.cookie??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith('tower_token='));
 if(values.length!==1)return res.sendStatus(401);
 let token:string;try{token=decodeURIComponent(values[0].slice(12));}catch{return res.sendStatus(401);}
 const payload=verifyToken(token);if(!payload?.userId||payload.aud)return res.sendStatus(401);
 try{const state=await getUserAuthState(payload.userId);
 if(!state||state.disabled||state.approvalStatus!=='active'||Number(payload.authEpoch??0)!==state.authEpoch||state.passwordChangedAt>Number((payload as any).iat)*1000+2000)return res.sendStatus(401);
 return res.json({token,userId:payload.userId,username:payload.username,role:state.role});
 }catch{return res.sendStatus(503);}
};}
export const cpBrowserScript=`(async()=>{const message=document.getElementById('message');try{const response=await fetch('/api/auth/cp/browser-session',{method:'POST',credentials:'same-origin',cache:'no-store'});if(!response.ok)throw Error();const data=await response.json();if(typeof data.token!=='string'||!Number.isSafeInteger(data.userId))throw Error();const old=localStorage.getItem('token');if(old&&old!==data.token){let id;try{id=JSON.parse(atob(old.split('.')[1])).userId;}catch{}if(id!==data.userId&&!window.confirm('다른 계정에서 CP 계정으로 전환할까요?')){message.textContent='계정 전환을 취소했습니다.';return;}}for(const key of ['token','userId','username','userRole'])localStorage.removeItem(key);localStorage.setItem('token',data.token);localStorage.setItem('userId',String(data.userId));localStorage.setItem('username',data.username);localStorage.setItem('userRole',data.role);window.location.replace('/');}catch{message.textContent='로그인 세션을 연결하지 못했습니다. 포털에서 Tower 접속을 다시 시작해 주세요.';}})();`;
