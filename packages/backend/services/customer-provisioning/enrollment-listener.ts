import {createServer,type Server} from 'node:http';
import {handleCustomerEnrollmentHttp} from './enrollment-http.js';
type Config=Parameters<typeof handleCustomerEnrollmentHttp>[1];
/** Explicit private service composition; disabled unless deployment supplies trusted authority/ports. */
export async function startCustomerEnrollmentListener(config:Config,port:number):Promise<Server>{
 if(!Number.isInteger(port)||port<1024||port>65535||!config.serviceToken||config.serviceToken.length<32||typeof config.authority?.authorize!=='function'||typeof config.ports?.issueAndStore!=='function')throw Error('enrollment_listener_config_invalid');
 const server=createServer(async(req,res)=>{
  const deny=(status:number)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:'enrollment_request_denied'}));};
  if(req.url!=='/v1/enrollment'){deny(404);req.resume();return;}
  if(req.method!=='POST'){deny(405);req.resume();return;}
  if(Number(req.headers['content-length'])>8192){deny(413);req.resume();return;}
  try{let size=0;const chunks:Buffer[]=[];for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>8192){deny(413);return;}chunks.push(b);}
   const headers=new Headers();for(const k of ['authorization','content-type']){const v=req.headers[k];if(typeof v==='string')headers.set(k,v);}
   const response=await handleCustomerEnrollmentHttp(new Request('http://127.0.0.1/v1/enrollment',{method:'POST',headers,body:Buffer.concat(chunks)}),config);
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
  }catch{if(!res.headersSent)deny(503);else res.end();}
 });server.requestTimeout=10000;server.headersTimeout=10000;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});return server;
}
