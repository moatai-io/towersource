import {runCustomerEnrollmentService,type CustomerEnrollmentServicePorts} from './enrollment-handler.js';
import type {CustomerServiceAuthority} from './service-boundary.js';
/** Deployment must explicitly register this handler on its private service network. */
export async function handleCustomerEnrollmentHttp(request:Request,config:{serviceToken?:string;authority:CustomerServiceAuthority;ports:CustomerEnrollmentServicePorts}):Promise<Response>{
 const reply=(status:number,body:object)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
 if(request.method!=='POST')return reply(405,{error:'method_not_allowed'});
 if(!config.serviceToken||config.serviceToken.length<32)return reply(503,{error:'customer_service_disabled'});
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return reply(415,{error:'json_required'});
 let raw:unknown;
 try{
  const reader=request.body?.getReader();if(!reader)return reply(400,{error:'invalid_input'});let size=0;const chunks:Uint8Array[]=[];
  try{for(;;){const x=await reader.read();if(x.done)break;size+=x.value.byteLength;if(size>8192){await reader.cancel();return reply(413,{error:'input_too_large'});}chunks.push(x.value);}}finally{reader.releaseLock();}
  raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 }catch{return reply(400,{error:'invalid_input'});}
 try{return reply(200,await runCustomerEnrollmentService(raw,request.headers.get('authorization')??undefined,config));}
 catch(e){const message=e instanceof Error?e.message:'';
  if(message==='customer_service_unauthenticated')return reply(401,{error:'customer_service_unauthenticated'});
  if(message==='customer_service_disabled')return reply(503,{error:'customer_service_disabled'});
  if(message==='customer_enrollment_outcome_unknown')return reply(502,{error:'customer_enrollment_outcome_unknown'});
  if(message.startsWith('customer_enrollment_readback'))return reply(502,{error:'customer_enrollment_readback_unverified'});
  return reply(403,{error:'customer_enrollment_access_denied'});
 }
}
