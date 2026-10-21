import {centralZuploObservation} from './central-zuplo-observation.js';import {centralLiteLlmObservation} from './central-litellm-observation.js';import {customerGatewayPolicyProxy} from './customer-gateway-policy-proxy.js';import {fileCentralIssuerAuthority,fileCentralZuploAuthority} from './central-issuer-authority.js';import {zuploManagementHttp} from './zuplo-management-http.js';import {localLiteLlmManagement} from './litellm-management-http.js';import {startEnrollmentObservationListener} from './enrollment-observation-listener.js';import type {ApprovedObservationTarget} from './enrollment-observation-http.js';
export interface CentralObservationServiceConfig {
 port:number;token:string;approvalDirectory:string;intentDirectory:string;zuploManagementToken:string;litellmManagement:Parameters<typeof localLiteLlmManagement>[0];
 targets:Array<ApprovedObservationTarget & {approvalHash:string;customerPolicy?:{endpoint:string;token:string}}>;
}
/** Read-only centralized observation from published approval + live provider inventory + customer policy. */
export async function startCentralObservationService(c:CentralObservationServiceConfig){
 if(!c.targets.length)throw Error('central_observation_targets_empty');
 const never=async()=>{throw Error('observation_must_not_consume_or_issue');};const opts={approvalDirectory:c.approvalDirectory,intentDirectory:c.intentDirectory,attest:never,verifyReceiver:never};
 const z=fileCentralZuploAuthority(opts),l=fileCentralIssuerAuthority(opts),zm=zuploManagementHttp(c.zuploManagementToken),lm=localLiteLlmManagement(c.litellmManagement);
 const routes:Map<string,(r:Request)=>Promise<Response>>=new Map();
 for(const row of c.targets){const t={customerId:row.customerId,instanceId:row.instanceId,proposalHash:row.proposalHash,providerKind:row.providerKind};const key=t.customerId+':'+t.instanceId+':'+t.proposalHash+':'+t.providerKind;if(routes.has(key))throw Error('central_observation_duplicate');
  const resolve=async()=>{const a=row.providerKind==='zuplo'?z:l;const contract=await a.contractFor(row.approvalHash,row.providerKind);if(contract.customerId!==t.customerId||contract.instanceId!==t.instanceId||contract.policyHash!==t.proposalHash)throw Error('central_observation_publication_mismatch');const {authorityId,revision,issuerRuntimeId,receiverRuntimeId,...delivery}=contract;return {a,delivery:{...delivery,intentId:await a.originalIntent(row.approvalHash,row.providerKind)}};};
  if(row.providerKind==='zuplo'){if(!row.customerPolicy)throw Error('central_customer_policy_missing');routes.set(key,centralZuploObservation({token:c.token,targets:[t],management:zm,resolve:async()=>{const {delivery}=await resolve();return (await z.approvedDelivery(delivery)).policy;},customerGatewayPolicy:customerGatewayPolicyProxy({instanceId:t.instanceId,...row.customerPolicy})}));}
  else routes.set(key,centralLiteLlmObservation({token:c.token,targets:[t],management:lm,resolve:async()=>{const {delivery}=await resolve();return {delivery,policy:(await l.approvedDelivery(delivery)).policy};}}));
 }
 return startEnrollmentObservationListener(c.port,{provider:async req=>{
  // Listener already bounds request body. Exact per-target handler authenticates and validates again.
  let x:any;try{x=await req.clone().json();}catch{return Response.json({error:'observation_denied'},{status:400});}
  const h=routes.get(x?.customerId+':'+x?.instanceId+':'+x?.proposalHash+':'+x?.providerKind);return h?h(req):Response.json({error:'observation_denied'},{status:403});
 }});
}
