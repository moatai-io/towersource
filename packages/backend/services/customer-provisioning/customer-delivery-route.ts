import {consumeOutboundDeliveryIntent} from './pg-outbound-delivery-intent.js';
import {customerSmokeRecovery} from './customer-smoke-recovery.js';
import {preflightCustomerGatewaySetup,validateGatewaySetup,applyCustomerGatewaySetup,verifyCustomerGatewaySetup,type ApprovedGatewaySetup} from './customer-gateway-setup.js';
import {consumeCustomerDeliveryIntent} from './pg-delivery-intent.js';
import fs from 'node:fs';
import {getPgPool} from '../../db/pg.js';
import {handleCustomerSmokeService} from './smoke-handler.js';
import {customerLiteLlmSmokePorts} from './litellm-smoke-ports.js';
import {installedSmokeLedger} from './installed-smoke-ledger.js';
import path from 'node:path';
import type {RequestHandler} from 'express';
import type {ApprovedDelivery} from './central-delivery.js';
import {handleCustomerDeliveryHttp,type CustomerDeliveryHttpConfig} from './customer-delivery-http.js';
import {customerVaultReceiver} from './customer-vault-receiver.js';
import {isCustomerSmokeModel} from './service-boundary.js';
import {customerRuntimeAuthority} from './runtime-authority.js';
import {pgCustomerRuntimeStore} from './pg-runtime-store.js';
import {assertCustomerVaultDestinationAbsent,readCustomerVaultDelivery,readCustomerVaultSecretReference} from './customer-vault-readback.js';

interface InstalledCustomerDeliveryPolicy {gatewaySetup?:ApprovedGatewaySetup;schemaVersion:1;delivery:ApprovedDelivery;inferenceBaseUrl:string;modelPolicy?:'gpt-only';smokeApprovalHash?:string;smokeModel?:string;smokeEstimateMicrousd?:number;}
function installedPolicy(file:string){
 if(!path.isAbsolute(file)||file.split('/').includes('..'))throw Error('customer_delivery_policy_invalid');
 for(let parent=path.dirname(file);parent!==path.dirname(parent);parent=path.dirname(parent)){
  const st=fs.lstatSync(parent);if(st.isSymbolicLink()||st.uid!==0||(st.mode&0o022)!==0)throw Error('customer_delivery_policy_not_protected');
 }
 const st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isFile()||st.uid!==0||(st.mode&0o022)!==0||st.size>16384)throw Error('customer_delivery_policy_not_protected');
 const bytes=fs.readFileSync(file),x=JSON.parse(bytes.toString('utf8')) as InstalledCustomerDeliveryPolicy;
 const fields=['intentId','customerId','instanceId','approvalHash','policyHash','providerKind','credentialId'];
 if(!x||(Object.keys(x).length!==(3+(x.modelPolicy===undefined?0:1)+(x.smokeEstimateMicrousd===undefined?0:1)+(x.gatewaySetup===undefined?0:1)+(x.smokeModel===undefined?0:1)+(x.smokeApprovalHash===undefined?0:1))||Object.keys(x).some(k=>!['schemaVersion','delivery','inferenceBaseUrl','modelPolicy','smokeEstimateMicrousd','gatewaySetup','smokeModel','smokeApprovalHash'].includes(k))||(x.modelPolicy!==undefined&&x.modelPolicy!=='gpt-only'))||x.schemaVersion!==1||!x.delivery||Object.keys(x.delivery).length!==7||fields.some(k=>typeof x.delivery[k as keyof ApprovedDelivery]!=='string')||!['litellm','zuplo'].includes(x.delivery.providerKind)||
  !/^[a-f0-9]{64}$/.test(x.delivery.approvalHash)||!/^[a-f0-9]{64}$/.test(x.delivery.policyHash)||![x.delivery.intentId,x.delivery.instanceId].every(v=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v))||![x.delivery.customerId,x.delivery.credentialId].every(v=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(v)))throw Error('customer_delivery_policy_invalid');
 if(x.smokeEstimateMicrousd!==undefined&&(!Number.isSafeInteger(x.smokeEstimateMicrousd)||x.smokeEstimateMicrousd<=0||x.smokeEstimateMicrousd>1000000))throw Error('customer_smoke_policy_invalid');
 if(x.smokeApprovalHash!==undefined&&!/^[a-f0-9]{64}$/.test(x.smokeApprovalHash))throw Error('customer_smoke_approval_invalid');
 if(x.smokeEstimateMicrousd!==undefined&&!isCustomerSmokeModel(x.smokeModel))throw Error('customer_smoke_model_required');
 if(x.delivery.providerKind==='zuplo'){if(!x.gatewaySetup)throw Error('customer_gateway_setup_required');validateGatewaySetup(x.delivery,x.gatewaySetup);}
 const u=new URL(x.inferenceBaseUrl);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('customer_delivery_policy_invalid');
 return {policy:x,bytes};
}
/** Root-installed local receiver wiring. Never grants authority or publishes an
 * intent on startup. Private relay must reach this via the local listener; no
 * user session or request field selects credentials, local actor, or endpoint. */
export function createInstalledCustomerDelivery(file:string,token:()=>string,localInstance:()=>string,mode:'inbound'|'outbound'='inbound'){
 const initial=installedPolicy(file),approved=structuredClone(initial.policy.delivery);
 const authority=customerRuntimeAuthority(pgCustomerRuntimeStore(async()=>{
  if(localInstance()!==approved.instanceId)throw Error('customer_delivery_instance_mismatch');return approved.instanceId;
 },approved.approvalHash));
 const operation=()=>({customerId:approved.customerId,instanceId:approved.instanceId,approvalHash:approved.approvalHash,providerKind:approved.providerKind,operation:'enrollment-issue' as const,intentId:approved.intentId});
 const receiver=customerVaultReceiver({
  async resolve(input){if(Object.keys(approved).some(k=>input[k as keyof ApprovedDelivery]!==approved[k as keyof ApprovedDelivery]))throw Error('customer_delivery_policy_mismatch');const binding=await authority.readRuntimeBinding();await authority.authorize({...operation(),binding});return binding;},
  assertDestinationAbsent:assertCustomerVaultDestinationAbsent,
  async consume(input,binding){if(mode==='outbound')await consumeOutboundDeliveryIntent(getPgPool(),input,binding);else await consumeCustomerDeliveryIntent(getPgPool(),input,binding);},
  readback:readCustomerVaultDelivery,secretReference:readCustomerVaultSecretReference,
 },undefined,{async approvedBaseUrl(){return initial.policy.inferenceBaseUrl;},async approvedProfile(){return initial.policy.modelPolicy;}},approved.providerKind==='zuplo'?{async preflight(d){await preflightCustomerGatewaySetup(d,initial.policy.gatewaySetup!);},async apply(d,b,r){await applyCustomerGatewaySetup(d,b,r,initial.policy.gatewaySetup!);},async verify(d,b,r){await verifyCustomerGatewaySetup(d,b,r,initial.policy.gatewaySetup!);}}:undefined);
 const assertInstalled=()=>{
  if(!initial.bytes.equals(installedPolicy(file).bytes)||localInstance()!==approved.instanceId||token().length<32)throw Error('customer_delivery_installed_binding_changed');
 };
 const guarded:typeof receiver={
  async verifyLocalAuthority(i){assertInstalled();await receiver.verifyLocalAuthority(i);},
  async consumeDeliveryIntent(i){assertInstalled();await receiver.consumeDeliveryIntent(i);},
  async store(i){assertInstalled();await receiver.store(i);},
  async readback(i){assertInstalled();return receiver.readback(i);}
 };
 // Separate root-installed smoke approval remains independently DB-authorized.
 // Legacy explicit v1 can keep enrollment hash; missing model still fails closed.
 const smokeApprovalHash=initial.policy.smokeApprovalHash??approved.approvalHash;
 const smokeAuthority=customerRuntimeAuthority(pgCustomerRuntimeStore(async()=>localInstance(),smokeApprovalHash));
 const route=customerDeliveryExpressAdapter({serviceToken:token(),ports:guarded},assertInstalled,async(request,action)=>{
  if(action==='receipt')return customerSmokeRecovery(request,{serviceToken:token(),authority:smokeAuthority});
  const estimate=initial.policy.smokeEstimateMicrousd;if(estimate===undefined)return Response.json({error:'customer_smoke_not_configured'},{status:503});
  const ports=customerLiteLlmSmokePorts(installedSmokeLedger(getPgPool(),{instanceId:approved.instanceId,approvalHash:smokeApprovalHash,estimatedMicrousd:estimate,model:initial.policy.smokeModel!}));
  return handleCustomerSmokeService(request,action,{serviceToken:token(),authority:smokeAuthority,ports});
 });
 return {createSmokePorts(){assertInstalled();const estimate=initial.policy.smokeEstimateMicrousd;if(approved.providerKind!=='litellm'||estimate===undefined)throw Error('customer_smoke_not_configured');return customerLiteLlmSmokePorts(installedSmokeLedger(getPgPool(),{instanceId:approved.instanceId,approvalHash:smokeApprovalHash,estimatedMicrousd:estimate,model:initial.policy.smokeModel!}));},route,receiver:guarded,approved:Object.freeze(approved),gatewaySetup:initial.policy.gatewaySetup,authority,assertInstalled};
}
export function createCustomerDeliveryRoute(file:string,token:()=>string,localInstance:()=>string):RequestHandler{return createInstalledCustomerDelivery(file,token,localInstance).route;}

/** Adapter kept separate for bounded local tests; actual configuration uses only
 * root-installed immutable policy and the explicit canonical PG/Vault adapters. */
export function customerDeliveryExpressAdapter(config:CustomerDeliveryHttpConfig,assertInstalled:()=>void,smoke?:(request:Request,action:'usage'|'estimate'|'execute'|'receipt')=>Promise<Response>):RequestHandler{
 return async(request,response,next)=>{
  const pathname=request.originalUrl.split('?')[0];if(!pathname.startsWith('/v1/credentials/')&&!pathname.startsWith('/v1/smoke/')){next();return;}
  response.setHeader('cache-control','no-store');
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress??'')){response.status(403).json({error:'customer_delivery_private_listener_required'});return;}
  try{
   assertInstalled();
   const reader=request[Symbol.asyncIterator]();
   const body=new ReadableStream<Uint8Array>({async pull(c){try{const next=await reader.next();if(next.done)c.close();else c.enqueue(Buffer.from(next.value));}catch{c.error(new Error('read_failed'));}},async cancel(){await reader.return?.();}});
   const headers=new Headers();for(const name of ['authorization','content-type']){const value=request.get(name);if(value)headers.set(name,value);}
   const req=new Request(new URL(request.originalUrl,'http://127.0.0.1'),{method:request.method,headers,...(request.method==='POST'?{body,duplex:'half'}:{})} as RequestInit);
   let result:Response;
   if(pathname.startsWith('/v1/smoke/')){
    const action=pathname.slice('/v1/smoke/'.length);
    if(!['usage','estimate','execute','receipt'].includes(action)||!smoke)result=Response.json({error:'not_found'},{status:404});
    else result=await smoke(req,action as 'usage'|'estimate'|'execute'|'receipt');
   }else result=await handleCustomerDeliveryHttp(req,config);response.status(result.status).type('json').send(await result.text());
  }catch{response.status(503).json({error:'customer_delivery_installed_binding_unavailable'});}
 };
}
