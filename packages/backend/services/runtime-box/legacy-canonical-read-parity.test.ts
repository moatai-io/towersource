import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { createRemoteWorkbenchWorkerServer } from '../execution/worker/worker-server.js';
import { readCanonicalProjectFileBytes } from '../project-environment/adapters/canonical-host-file-adapter.js';
// Synthetic bytes only. Compares storage adapters, not user ACL or real migration.
let base: string; let root: string; let server: http.Server; let url: string;
beforeEach(async () => {
 base=await fs.mkdtemp(path.join(os.tmpdir(),'storage-parity-'));root=path.join(base,'project');await fs.mkdir(root);
 await fs.writeFile(path.join(root,'regular.txt'),'synthetic ordinary data');
 await fs.writeFile(path.join(base,'external.txt'),'synthetic outside data');
 await fs.symlink('regular.txt',path.join(root,'internal-link'));
 await fs.symlink('../external.txt',path.join(root,'external-link'));
 await fs.link(path.join(root,'regular.txt'),path.join(root,'hardlink'));
 await fs.writeFile(path.join(root,'single.txt'),'single inode');
 server=createRemoteWorkbenchWorkerServer({workerId:'parity',token:'synthetic-parity',projects:{p:root}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 url=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
});
afterEach(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await fs.rm(base,{recursive:true,force:true});});
async function legacy(name:string){const r=await fetch(`${url}/v1/files/p/content?path=${encodeURIComponent(name)}`,{headers:{authorization:'Bearer synthetic-parity'}});return {status:r.status,body:await r.text()};}
it('preserves ordinary single-link file bytes',async()=>{expect(await legacy('single.txt')).toEqual({status:200,body:'single inode'});expect(readCanonicalProjectFileBytes(root,'single.txt',1024).toString()).toBe('single inode');});
it.each(['internal-link','external-link','hardlink','regular.txt'])('characterizes stricter canonical read of %s without changing any file',async name=>{
 expect((await legacy(name)).status).toBe(200);
 expect(()=>readCanonicalProjectFileBytes(root,name,1024)).toThrow();
 expect(await fs.readFile(path.join(root,'regular.txt'),'utf8')).toBe('synthetic ordinary data');
});
