import {timingSafeEqual} from 'node:crypto';
import {receiveCustomerCredential,type ApprovedDelivery,type CustomerCredentialReceiverPorts} from './central-delivery.js';

export interface CustomerDeliveryHttpConfig {serviceToken?:string;ports:CustomerCredentialReceiverPorts;}
function authenticated(authorization:string|null,token:string){
 const expected=Buffer.from('Bearer '+token),actual=Buffer.from(authorization??'');
 return expected.length===actual.length&&timingSafeEqual(expected,actual);
}
const fields=['intentId','customerId','instanceId','approvalHash','policyHash','providerKind','credentialId'];
function deliveryInput(raw:unknown,store:boolean):ApprovedDelivery & {providerResourceId?:string;value?:string}{
 const keys=store?[...fields,'providerResourceId','value']:fields;
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==keys.length||!keys.every(k=>Object.hasOwn(raw,k)))throw Error();
 const x=raw as Record<string,unknown>,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,id=/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/,hash=/^[a-f0-9]{64}$/;
 if(!fields.every(k=>typeof x[k]==='string')||!uuid.test(x.intentId as string)||!uuid.test(x.instanceId as string)||!id.test(x.customerId as string)||!id.test(x.credentialId as string)||!hash.test(x.approvalHash as string)||!hash.test(x.policyHash as string)||!['litellm','zuplo'].includes(x.providerKind as string))throw Error();
 if(store&&(typeof x.value!=='string'||!x.value.trim()||x.value.length>8192||typeof x.providerResourceId!=='string'||!id.test(x.providerResourceId)))throw Error();
 return x as unknown as ApprovedDelivery & {providerResourceId?:string;value?:string};
}
/** Explicit private receiver adapter. Not mounted on the public customer API. */
export async function handleCustomerDeliveryHttp(request:Request,config:CustomerDeliveryHttpConfig):Promise<Response>{
 const reply=(status:number,body:object)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
 if(request.method!=='POST')return reply(405,{error:'method_not_allowed'});
 if(!config.serviceToken||config.serviceToken.length<32)return reply(503,{error:'customer_delivery_disabled'});
 if(!authenticated(request.headers.get('authorization'),config.serviceToken))return reply(401,{error:'customer_delivery_unauthenticated'});
 const path=new URL(request.url).pathname;
 if(!['/v1/credentials/deliver','/v1/credentials/readback','/v1/credentials/preflight'].includes(path))return reply(404,{error:'not_found'});
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return reply(415,{error:'json_required'});
 let raw:unknown;
 try{
  const reader=request.body?.getReader();if(!reader)return reply(400,{error:'invalid_input'});
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>16384){await reader.cancel();return reply(413,{error:'input_too_large'});}chunks.push(next.value);}}finally{reader.releaseLock();}
  raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 }catch{return reply(400,{error:'invalid_input'});}
 const store=path.endsWith('/deliver');let input:ReturnType<typeof deliveryInput>;
 try{input=deliveryInput(raw,store);}catch{return reply(400,{error:'invalid_input'});}
 try{
  if(path.endsWith('/preflight')){
   try{await config.ports.verifyLocalAuthority(input);}catch{return reply(403,{error:'delivery_receiver_unverified'});}
   return reply(200,{...input,ready:true});
  }
  // No absence check or intent consumption on readback; local readback itself
  // rechecks fresh authority and the exact original delivery binding.
  const receipt=store
   ?await receiveCustomerCredential(input as ApprovedDelivery & {providerResourceId:string;value:string},request.headers.get('authorization')??undefined,config.serviceToken,config.ports)
   :await config.ports.readback(input);
  if(Object.keys(receipt).length!==9||fields.some(k=>receipt[k as keyof ApprovedDelivery]!==input[k as keyof ApprovedDelivery])||receipt.stored!==true||(store&&receipt.providerResourceId!==input.providerResourceId)||typeof receipt.providerResourceId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(receipt.providerResourceId))throw Error();
  return reply(200,receipt);
 }catch(error){
  if(store&&error instanceof Error&&error.message==='delivery_receiver_authority_denied')return reply(403,{error:'customer_delivery_authority_denied'});
  return reply(502,{error:store?'customer_delivery_recovery_required_no_replay':'customer_delivery_readback_unverified'});
 }
}
