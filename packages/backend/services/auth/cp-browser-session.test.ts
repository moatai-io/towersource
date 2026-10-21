import {beforeEach,it,expect,vi} from 'vitest';
vi.mock('./auth.js',()=>({verifyToken:vi.fn(),getUserAuthState:vi.fn()}));
import {cpBrowserSession,cpBrowserScript} from './cp-browser-session.js';
import {verifyToken,getUserAuthState} from './auth.js';
import {runInNewContext} from 'node:vm';
const origin='https://sample.tower.example.org';
function response(){return {set:vi.fn(),sendStatus:vi.fn(),json:vi.fn()};}
beforeEach(()=>{vi.clearAllMocks();vi.mocked(verifyToken).mockReturnValue({userId:2,username:'fixture',authEpoch:1,iat:100} as any);vi.mocked(getUserAuthState).mockResolvedValue({role:'admin',authEpoch:1,disabled:false,approvalStatus:'active',passwordChangedAt:0} as any);});
it.each([
 {headers:{origin:'https://evil.test',cookie:'tower_token=fixture'},status:403},
 {headers:{origin,cookie:''},status:401},
 {headers:{origin,cookie:'tower_token=a; tower_token=b'},status:401},
 {headers:{origin,cookie:'tower_token=%zz'},status:401},
])('denies ambiguous or unbound cookie request %#',async({headers,status})=>{const r=response();await cpBrowserSession(origin)({headers} as any,r as any);expect(r.sendStatus).toHaveBeenCalledWith(status);expect(r.json).not.toHaveBeenCalled();expect(getUserAuthState).not.toHaveBeenCalled();});
it('returns only the existing same-origin session and current account role',async()=>{const r=response();await cpBrowserSession(origin)({headers:{origin,cookie:'tower_token=fixture'}} as any,r as any);expect(r.json).toHaveBeenCalledWith({token:'fixture',userId:2,username:'fixture',role:'admin'});expect(r.set).toHaveBeenCalledWith({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});});
it.each([null,{userId:2,aud:'api-token'}])('denies invalid or audience-bound token %#',async(payload)=>{vi.mocked(verifyToken).mockReturnValue(payload as any);const r=response();await cpBrowserSession(origin)({headers:{origin,cookie:'tower_token=fixture'}} as any,r as any);expect(r.sendStatus).toHaveBeenCalledWith(401);expect(getUserAuthState).not.toHaveBeenCalled();});
it.each([null,{disabled:true},{approvalStatus:'pending'},{authEpoch:2},{passwordChangedAt:103000}])('denies invalidated account state %#',async(override)=>{vi.mocked(getUserAuthState).mockResolvedValue(override===null?null:{role:'admin',authEpoch:1,disabled:false,approvalStatus:'active',passwordChangedAt:0,...override} as any);const r=response();await cpBrowserSession(origin)({headers:{origin,cookie:'tower_token=fixture'}} as any,r as any);expect(r.sendStatus).toHaveBeenCalledWith(401);expect(r.json).not.toHaveBeenCalled();});
it('fails closed on database error',async()=>{vi.mocked(getUserAuthState).mockRejectedValueOnce(Error('fixture outage'));const r=response();await cpBrowserSession(origin)({headers:{origin,cookie:'tower_token=fixture'}} as any,r as any);expect(r.sendStatus).toHaveBeenCalledWith(503);expect(r.json).not.toHaveBeenCalled();});
it.each([['fresh',null,true],['same','2',true],['different','3',false],['different-approved','3',true]])('browser bridge %s preserves settings and requires account confirmation',async(label,current,confirm)=>{
 const oldToken=current?'fixture.'+Buffer.from(JSON.stringify({userId:Number(current)})).toString('base64')+'.sig':null;
 const values=new Map([['theme','dark'],...(current?[['userId',current],['token',oldToken!]]:[])]);const replacements:string[]=[];const confirmation=vi.fn(()=>confirm);const message={textContent:''};
 const fetcher=vi.fn(async()=>({ok:true,json:async()=>({token:'fixture-session',userId:2,username:'fixture',role:'admin'})}));
 await runInNewContext(cpBrowserScript,{document:{getElementById:()=>message},fetch:fetcher,localStorage:{getItem:(k:string)=>values.get(k)??null,removeItem:(k:string)=>values.delete(k),setItem:(k:string,v:string)=>values.set(k,v)},window:{confirm:confirmation,location:{replace:(p:string)=>replacements.push(p)}},Error,String,atob:(s:string)=>Buffer.from(s,'base64').toString()});
 expect(fetcher).toHaveBeenCalledWith('/api/auth/cp/browser-session',expect.objectContaining({method:'POST',credentials:'same-origin',cache:'no-store'}));expect(values.get('theme')).toBe('dark');
 if(label==='different'){expect(values.get('token')).toBe(oldToken);expect(replacements).toEqual([]);}else{expect(values.get('userId')).toBe('2');expect(values.get('token')).toBe('fixture-session');expect(replacements).toEqual(['/']);}
 expect(confirmation).toHaveBeenCalledTimes(current==='3'?1:0);
});
it('browser failed bootstrap never clears an existing session',async()=>{const remove=vi.fn();const redirect=vi.fn();const message={textContent:''};await runInNewContext(cpBrowserScript,{document:{getElementById:()=>message},fetch:async()=>({ok:false}),localStorage:{removeItem:remove},window:{location:{replace:redirect}},Error});expect(remove).not.toHaveBeenCalled();expect(redirect).not.toHaveBeenCalled();expect(message.textContent).toContain('로그인 세션을 연결하지 못했습니다.');});
