import { expect,it,vi } from 'vitest';
import { runBrowserFileCanary } from './browser-file-canary';
function fixture(stale=false){let content='';const request=vi.fn(async(url:string,init?:RequestInit)=>{
 if(init?.body)content=JSON.parse(String(init.body)).content;
 return new Response(JSON.stringify({storageAuthority:'host',content:stale&&url.includes('/read')?'stale':content}),{status:200});
});return request;}
it('passes browser API roundtrip and never calls delete or command endpoint',async()=>{
 const request=fixture();const result=await runBrowserFileCanary('/project',request);
 expect(result).toMatchObject({status:'PASS',retained:true,scope:'browser-file-api'});
 expect(request.mock.calls.map(c=>c[0].split('?')[0])).toEqual(['/api/files/create','/api/files/read','/api/files/write','/api/files/read']);
 expect(result.unverified).toContain('worker-execution');
});
it('fails stale content without retrying or deleting',async()=>{
 const request=fixture(true);expect(await runBrowserFileCanary('/project',request)).toMatchObject({status:'FAIL',failure:'read-first'});expect(request).toHaveBeenCalledTimes(2);
});
it('rejects noncanonical responses',async()=>{
 const request=vi.fn(async()=>new Response(JSON.stringify({storageAuthority:'worker'})));
 expect(await runBrowserFileCanary('/project',request)).toMatchObject({status:'FAIL',failure:'create'});expect(request).toHaveBeenCalledTimes(1);
});
it('blocks invalid roots before any request',async()=>{
 const request=fixture();expect(await runBrowserFileCanary('/project/../other',request)).toMatchObject({status:'BLOCKED',retained:false});expect(request).not.toHaveBeenCalled();
});
it('redacts errors and reports uncertain creation as retained',async()=>{
 const request=vi.fn(async()=>{throw Error('private token');});const r=await runBrowserFileCanary('/project',request);
 expect(r).toMatchObject({status:'FAIL',retained:true});expect(JSON.stringify(r)).not.toContain('private token');
});
