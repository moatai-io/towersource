import {createServer} from 'node:http';
/** Private observation listener. Deployment explicitly supplies central provider and/or customer Vault routes. */
export async function startEnrollmentObservationListener(port:number,routes:Partial<Record<'provider'|'vault'|'gateway-policy',(request:Request)=>Promise<Response>>>){
 if(!Number.isInteger(port)||port<1024||port>65535||!Object.keys(routes).length||Object.keys(routes).some(k=>!['provider','vault','gateway-policy'].includes(k)||typeof routes[k as 'provider'|'vault'|'gateway-policy']!=='function'))throw Error('observation_listener_invalid');
 const handlers={...routes};
 const server=createServer(async(req,res)=>{
  const deny=(status:number)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end('{"error":"observation_denied"}');};
  const kind=req.url==='/v1/observe/provider'?'provider':req.url==='/v1/observe/vault'?'vault':req.url==='/v1/observe/gateway-policy'?'gateway-policy':null;
  if(!kind||!handlers[kind]){req.resume();deny(404);return;}
  if(req.method!==(kind==='gateway-policy'?'GET':'POST')){req.resume();deny(405);return;}
  try{
   const parts:Buffer[]=[];let size=0;for await(const part of req){const b=Buffer.from(part);size+=b.length;if(size>8192){deny(413);return;}parts.push(b);}
   const response=await handlers[kind]!(new Request('http://localhost'+req.url,{method:kind==='gateway-policy'?'GET':'POST',headers:{authorization:String(req.headers.authorization??''),'content-type':'application/json'},...(kind==='gateway-policy'?{}:{body:Buffer.concat(parts)})}));
   res.writeHead(response.status,{'content-type':'application/json','cache-control':'no-store'});res.end(await response.text());
  }catch{if(!res.headersSent)deny(503);else res.end();}
 });server.requestTimeout=15000;server.headersTimeout=15000;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
 return {port,async close(){await new Promise<void>(r=>{server.close(()=>r());server.closeIdleConnections();});}};
}
