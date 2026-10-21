import {timingSafeEqual} from 'node:crypto';
import {readCustomerGatewayPolicy} from './customer-gateway-policy-readback.js';
/** Private customer-owned policy evidence endpoint; installation selects all identities. */
export function customerGatewayPolicyHttp(config:{token:string;instanceId:string;profileId:string;credentialId:string;consumerRef:()=>Promise<string>;assertInstalled():void;localInstanceId:()=>Promise<string>}){
 if(config.token.length<32)throw Error('gateway_policy_http_unconfigured');
 return async(req:Request)=>{
  const deny=(status:number)=>Response.json({error:'gateway_policy_unavailable'},{status,headers:{'cache-control':'no-store'}});
  const a=Buffer.from(req.headers.get('authorization')??''),b=Buffer.from('Bearer '+config.token);if(a.length!==b.length||!timingSafeEqual(a,b))return deny(401);
  if(req.method!=='GET')return deny(405);
  try{config.assertInstalled();const result=await readCustomerGatewayPolicy({instanceId:config.instanceId,profileId:config.profileId,credentialId:config.credentialId,consumerRef:await config.consumerRef()},config.localInstanceId);config.assertInstalled();return Response.json({...result,instanceId:config.instanceId,observedAt:new Date().toISOString()},{headers:{'cache-control':'no-store'}});}catch{return deny(503);}
 };
}
