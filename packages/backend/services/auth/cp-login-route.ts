import {randomBytes} from 'node:crypto';
import {cpBrowserSession,cpBrowserScript} from './cp-browser-session.js';
import express from 'express';import {cpLoginExchange} from './cp-login-exchange.js';import {cpLoginUsers} from './cp-login-users.js';
/** Opt-in route; local recovery login remains available. No shared parent-domain cookies. */
export function cpLoginRoutes(env:NodeJS.ProcessEnv){
 const router=express.Router();if(env.TOWER_CP_LOGIN_ENABLED!=='1')return router;
 const {TOWER_CP_ORIGIN:origin,TOWER_INSTANCE_ID:instance,TOWER_CP_ORGANIZATION_ID:org,TOWER_CP_RECEIVER_TOKEN:token,PUBLIC_URL:publicUrl}=env;
 if(!origin||!instance||!org||!token||!publicUrl)throw Error('cp_login_runtime_unconfigured');
 const app=new URL(publicUrl);if(app.protocol!=='https:'||! /^[a-z0-9][a-z0-9-]*\.(?:tower\.example\.org|tower\.example\.com)$/.test(app.hostname))throw Error('cp_login_app_origin_invalid');
 const cp=new URL(origin);const service=cpLoginExchange({cpOrigin:origin,instanceId:instance,organizationId:org,receiverToken:token},cpLoginUsers(cp.origin));
 router.post('/cp/browser-session',cpBrowserSession(app.origin));
 router.get('/cp/complete',(_req,res)=>{const nonce=randomBytes(24).toString('base64');res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Type':'text/html; charset=utf-8','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`});res.send(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tower 로그인 연결</title><p id="message">로그인을 연결하고 있습니다.</p><script nonce="${nonce}">${cpBrowserScript}</script></html>`);});
 const cookieOptions={httpOnly:true,secure:true,sameSite:'none' as const,path:'/',maxAge:60000};
 router.get('/cp/start',(_req,res)=>{
  const b=service.begin();res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.cookie('__Host-tower_cp_state',b.state,cookieOptions);res.cookie('__Host-tower_cp_verifier',b.verifier,cookieOptions);
  const url=new URL('/tower-login',cp);url.searchParams.set('instanceId',instance);url.searchParams.set('state',b.state);url.searchParams.set('challenge',b.challenge);res.redirect(303,url.href);
 });
 router.post('/cp/callback',express.urlencoded({extended:false,limit:'4kb'}),async(req,res)=>{
  res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
  try{
   if(req.headers.origin!==cp.origin||!req.is('application/x-www-form-urlencoded')||Object.keys(req.body).sort().join(',')!=='code,state')throw Error('callback_origin_invalid');
   const cookie=(name:string)=>{const vals=(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'='));if(vals.length!==1)throw Error('browser_cookie_invalid');return decodeURIComponent(vals[0].slice(name.length+1));};
   const session=await service.complete({code:req.body.code,state:req.body.state,browserState:cookie('__Host-tower_cp_state'),verifier:cookie('__Host-tower_cp_verifier')});
   res.clearCookie('__Host-tower_cp_state',{secure:true,path:'/',sameSite:'none'});res.clearCookie('__Host-tower_cp_verifier',{secure:true,path:'/',sameSite:'none'});
   res.cookie('tower_token',session,{httpOnly:true,secure:true,sameSite:'strict',path:'/',maxAge:300000});res.redirect(303,'/api/auth/cp/complete');
  }catch{res.status(403).json({error:'cp_login_denied_restart_from_tower'});}
 });return router;
}
