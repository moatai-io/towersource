import {it,expect,vi} from 'vitest';import express from 'express';import http from 'node:http';
vi.mock('./auth.js',()=>({verifyToken:vi.fn(()=>null),getUserAuthState:vi.fn(async()=>null)}));
vi.mock('./cp-login-users.js',()=>({cpLoginUsers:()=>({createSession:async()=> 'fixture-session'})}));
import {cpLoginRoutes} from './cp-login-route.js';
it('disabled route absent and enabled start uses host-only browser binding cookies',async()=>{
 const app=express();app.use('/api/auth',cpLoginRoutes({TOWER_CP_LOGIN_ENABLED:'1',TOWER_CP_ORIGIN:'https://control.example',TOWER_INSTANCE_ID:'22222222-2222-4222-8222-222222222222',TOWER_CP_ORGANIZATION_ID:'33333333-3333-4333-8333-333333333333',TOWER_CP_RECEIVER_TOKEN:'fixture-receiver-'.repeat(4),PUBLIC_URL:'https://test1.tower.example.com'}));
 const s=app.listen(0,'127.0.0.1');await new Promise<void>(r=>s.once('listening',r));
 try{const r=await new Promise<http.IncomingMessage>((resolve,reject)=>{http.get('http://127.0.0.1:'+(s.address() as any).port+'/api/auth/cp/start',resolve).on('error',reject);});r.resume();expect(r.statusCode).toBe(303);const cookies=r.headers['set-cookie']!.join(';');expect(cookies).toContain('__Host-tower_cp_state=');expect(cookies).toContain('Secure');expect(cookies).toContain('HttpOnly');expect(cookies).not.toContain('Domain=');expect(r.headers.location).toContain('https://control.example/tower-login');expect(r.headers.location).not.toContain('fixture-receiver');}finally{await new Promise<void>(r=>s.close(()=>r()));}
});
it('callback exchanges only bound CP POST and creates host-only local cookie',async()=>{
 const config={TOWER_CP_LOGIN_ENABLED:'1',TOWER_CP_ORIGIN:'https://control.example',TOWER_INSTANCE_ID:'22222222-2222-4222-8222-222222222222',TOWER_CP_ORGANIZATION_ID:'33333333-3333-4333-8333-333333333333',TOWER_CP_RECEIVER_TOKEN:'fixture-receiver-'.repeat(4),PUBLIC_URL:'https://test1.tower.example.com'};
 const app=express();app.use('/api/auth',cpLoginRoutes(config));const s=app.listen(0,'127.0.0.1');await new Promise<void>(r=>s.once('listening',r));
 const body='code='+'a'.repeat(43)+'&state='+'b'.repeat(43),cookie='__Host-tower_cp_state='+'b'.repeat(43)+'; __Host-tower_cp_verifier='+'c'.repeat(43);
 const fetcher=vi.fn(async()=>Response.json({subjectId:'11111111-1111-4111-8111-111111111111',organizationId:config.TOWER_CP_ORGANIZATION_ID,instanceId:config.TOWER_INSTANCE_ID,role:'owner',displayName:'Fixture'}));vi.stubGlobal('fetch',fetcher);
 const send=(origin:string)=>new Promise<{status:number;headers:http.IncomingHttpHeaders}>((resolve,reject)=>{const r=http.request({host:'127.0.0.1',port:(s.address() as any).port,path:'/api/auth/cp/callback',method:'POST',headers:{origin,cookie,'content-type':'application/x-www-form-urlencoded','content-length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers}));});r.on('error',reject);r.end(body);});
 try{expect((await send('https://evil.example')).status).toBe(403);expect(fetcher).not.toHaveBeenCalled();const r=await send(config.TOWER_CP_ORIGIN);expect(r.status).toBe(303);expect(r.headers.location).toBe('/api/auth/cp/complete');const cookies=r.headers['set-cookie']!.join(';');expect(cookies).toContain('tower_token=fixture-session');expect(cookies).not.toContain('Domain=');expect(cookies).toContain('HttpOnly');expect(cookies).toContain('Secure');}finally{vi.unstubAllGlobals();await new Promise<void>(r=>s.close(()=>r()));}
});

it.each(['sample.tower.example.org','sample.tower.example.com'])('supported host %s serves nonce-only completion and denies unauthenticated bootstrap',async(host)=>{
 const app=express();app.use('/api/auth',cpLoginRoutes({TOWER_CP_LOGIN_ENABLED:'1',TOWER_CP_ORIGIN:'https://control.example',TOWER_INSTANCE_ID:'22222222-2222-4222-8222-222222222222',TOWER_CP_ORGANIZATION_ID:'33333333-3333-4333-8333-333333333333',TOWER_CP_RECEIVER_TOKEN:'fixture-receiver-'.repeat(4),PUBLIC_URL:'https://'+host}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const req=(path:string,method='GET',origin?:string)=>new Promise<{status:number,headers:http.IncomingHttpHeaders,body:string}>((resolve,reject)=>{const q=http.request({hostname:'127.0.0.1',port:(server.address() as any).port,path,method,headers:origin?{origin}:{}},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body}));});q.on('error',reject);q.end();});
 try{
  const a=await req('/api/auth/cp/complete'),b=await req('/api/auth/cp/complete');expect(a.status).toBe(200);expect(a.headers['cache-control']).toBe('no-store');expect(a.headers['referrer-policy']).toBe('no-referrer');
  const nonce=a.body.match(/<script nonce="([^"]+)"/)!;expect(nonce).not.toBeNull();expect(a.headers['content-security-policy']).toContain(`script-src 'nonce-${nonce[1]}'`);expect(a.headers['content-security-policy']).toContain("connect-src 'self'");expect(b.body).not.toContain(nonce[1]);expect(a.headers['set-cookie']).toBeUndefined();
  expect((await req('/api/auth/cp/browser-session','POST','https://evil.example')).status).toBe(403);
  expect((await req('/api/auth/cp/browser-session','POST','https://'+host)).status).toBe(401);
  expect((await req('/api/auth/cp/browser-session')).status).toBe(404);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
