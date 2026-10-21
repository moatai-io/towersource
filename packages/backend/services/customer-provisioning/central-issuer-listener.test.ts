import {createServer} from 'node:http';
import {expect,it,vi} from 'vitest';
import {startCentralIssuerListener} from './central-issuer-listener.js';
const token='fixture-token-'.repeat(4);
async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return p;}
it('requires explicit secure local configuration',async()=>{
 await expect(startCentralIssuerListener({serviceToken:'short',contractFor:vi.fn(),ports:{} as any},32378)).rejects.toThrow('config_invalid');
});
it('real listener is fail-closed for route, method, authentication and body size',async()=>{
 const contractFor=vi.fn(),port=await freePort();const l=await startCentralIssuerListener({serviceToken:token,contractFor,ports:{} as any},port);
 try{
  expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
  const u=`http://127.0.0.1:${port}/internal/customer-provider-enrollment`;
  expect((await fetch(u)).status).toBe(405);
  expect((await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(401);
  expect((await fetch(u,{method:'POST',body:'x'.repeat(8193)})).status).toBe(413);
  expect(contractFor).not.toHaveBeenCalled();
 }finally{await l.close();}
});
