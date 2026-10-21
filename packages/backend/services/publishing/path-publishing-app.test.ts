import http from 'node:http';
import {it,expect} from 'vitest';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {pathPublishingApp} from './path-publishing-app.js';
it.each(['sample.publish.tower.example.com','sample.publish.tower.example.org'])('serves only registered public bytes on %s; no SPA or private fallback',async(hostname)=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'publishing-path-'));const sites=path.join(root,'sites');await fs.mkdir(path.join(sites,'report'),{recursive:true});await fs.writeFile(path.join(sites,'report','index.html'),'published-marker');await fs.writeFile(path.join(sites,'report','style.css'),'body{}');const manifest=path.join(root,'manifest.json');await fs.writeFile(manifest,JSON.stringify({sites:[{slug:'report',access:'unlisted'}]}));
 const app=pathPublishingApp({hostname,sitesRoot:sites,manifestPath:manifest});const s=app.listen(0,'127.0.0.1');await new Promise<void>(r=>s.once('listening',r));const base='http://127.0.0.1:'+(s.address() as any).port;const headers={Host:hostname};
 const fetch=(url:string,o:{headers:Record<string,string>})=>new Promise<{status:number;text():Promise<string>;headers:{has(k:string):boolean}}>((resolve,reject)=>{http.get(url,{headers:o.headers},r=>{let body='';r.on('data',b=>body+=b);r.on('end',()=>resolve({status:r.statusCode!,text:async()=>body,headers:{has:k=>k in r.headers}}));}).on('error',reject);});
 try{const r=await fetch(base+'/report/',{headers});expect(r.status).toBe(200);expect(await r.text()).toBe('published-marker');expect(r.headers.has('set-cookie')).toBe(false);expect((await fetch(base+'/report/style.css',{headers})).status).toBe(200);
 for(const p of ['/unknown/','/api/auth/status','/report/missing','/report/.env'])expect((await fetch(base+p,{headers})).status).toBe(404);
 expect((await fetch(base+'/report/',{headers:{Host:'test1.tower.example.com'}})).status).toBe(404);
 await fs.writeFile(manifest,JSON.stringify({sites:[{slug:'report',access:'private'}]}));expect((await fetch(base+'/report/',{headers})).status).toBe(404);
 }finally{await new Promise<void>(r=>s.close(()=>r()));await fs.rm(root,{recursive:true,force:true});}
});
