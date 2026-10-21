import {createServer,type Server} from 'node:http';
import {handleCentralRelayHttp,type CentralRelayHttpConfig} from './central-relay-http.js';
/** Private container-local entrypoint; deployment publishes approved contracts separately. */
export async function startCentralIssuerListener(config:CentralRelayHttpConfig,port:number):Promise<{port:number;close():Promise<void>}> {
 if(!Number.isInteger(port)||port<1||port>65535||!config.serviceToken||config.serviceToken.length<32||typeof config.contractFor!=='function')throw Error('central_issuer_listener_config_invalid');
 const server:Server=createServer(async(req,res)=>{
  res.setHeader('cache-control','no-store');
  const reply=(status:number,error:string)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error}));};
  if(req.url!=='/internal/customer-provider-enrollment'){reply(404,'not_found');req.resume();return;}
  if(req.method!=='POST'){reply(405,'method_not_allowed');req.resume();return;}
  const declared=Number(req.headers['content-length']);if(Number.isFinite(declared)&&declared>8192){reply(413,'input_too_large');req.resume();return;}
  try{
   let size=0;const chunks:Buffer[]=[];
   for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>8192){reply(413,'input_too_large');return;}chunks.push(b);}
   const headers=new Headers();for(const name of ['authorization','content-type']){const v=req.headers[name];if(typeof v==='string')headers.set(name,v);}
   const request=new Request('http://127.0.0.1/internal/customer-provider-enrollment',{method:'POST',headers,body:Buffer.concat(chunks)});
   const result=await handleCentralRelayHttp(request,config);res.writeHead(result.status,{'content-type':'application/json'});res.end(await result.text());
  }catch{if(!res.headersSent)reply(503,'central_issuer_unavailable');else res.end();}
 });
 server.requestTimeout=10000;server.headersTimeout=10000;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
 return {port,close:()=>new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeIdleConnections();})};
}
