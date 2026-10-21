import {afterEach,expect,it,vi} from 'vitest';
import {localLiteLlmManagement} from './litellm-management-http.js';
const key='fixture-master-'.repeat(4);
afterEach(()=>vi.unstubAllGlobals());
it('requires container-local endpoint and adequate credential',()=>{
 for(const baseUrl of ['https://remote.example/','http://localhost/','http://127.0.0.1/v1','http://127.0.0.1/?key=x'])expect(()=>localLiteLlmManagement({baseUrl,masterKey:key})).toThrow('config_invalid');
});
it('denies arbitrary endpoints, external origin and methods before fetch',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const p=localLiteLlmManagement({baseUrl:'http://127.0.0.1:4000/',masterKey:key});
 for(const path of ['/key/delete','http://evil.example/team/info?team_id=x','/team/info?team_id=x&extra=y','/team/info'])await expect(p.request(path,'GET')).rejects.toThrow('operation_denied');
 expect(fetch).not.toHaveBeenCalled();
});
it('uses nonredirecting bounded authenticated management transport',async()=>{
 const fetch=vi.fn(async()=>Response.json({team_info:{team_id:'fixture'}}));vi.stubGlobal('fetch',fetch);
 const p=localLiteLlmManagement({baseUrl:'http://127.0.0.1:4000/',masterKey:key});expect(await p.request('/team/info?team_id=fixture','GET')).toEqual({team_info:{team_id:'fixture'}});
 expect(fetch.mock.calls[0][1]).toMatchObject({redirect:'error',headers:{authorization:'Bearer '+key}});
});
it('never emits provider error bodies or transport secrets',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(key,{status:401})));
 const p=localLiteLlmManagement({baseUrl:'http://127.0.0.1:4000/',masterKey:key});await expect(p.request('/key/generate','POST',{})).rejects.toThrow('litellm_management_request_failed');
 vi.stubGlobal('fetch',vi.fn(async()=>{throw Error(key);}));await expect(p.request('/key/generate','POST',{})).rejects.toThrow('litellm_management_transport_unknown');
});
it('rejects oversized and non-JSON response',async()=>{
 const p=localLiteLlmManagement({baseUrl:'http://127.0.0.1:4000/',masterKey:key});
 for(const body of ['x'.repeat(262145),'not-json']){vi.stubGlobal('fetch',vi.fn(async()=>new Response(body)));await expect(p.request('/team/info?team_id=x','GET')).rejects.toThrow('response_invalid');}
});
