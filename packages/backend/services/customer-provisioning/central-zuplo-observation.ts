import {createHash} from 'node:crypto';
import {enrollmentObservationHttp,type ApprovedObservationTarget} from './enrollment-observation-http.js';
import type {ApprovedZuploKeyPolicy} from './zuplo-key-issuer.js';
import type {zuploManagementHttp} from './zuplo-management-http.js';
const canonical=(x:any):string=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
/** Consumer existence/ownership is checked independently from self-hosted instance Gateway Profile policy.
 * Consumer metadata alone must not be treated as proof of VM-local enabled/quota configuration.
 */
export function centralZuploObservation(config:{token:string;targets:readonly ApprovedObservationTarget[];management:Pick<ReturnType<typeof zuploManagementHttp>,'readConsumer'>;
 resolve(t:Readonly<ApprovedObservationTarget>):Promise<ApprovedZuploKeyPolicy>;
 customerGatewayPolicy(instanceId:string):Promise<{policy:{profileVersion:string;enabledApiIds:string[];quotaMode:'observe'|'enforce'};revision:string}>;
}){
 return enrollmentObservationHttp({token:config.token,kind:'provider',targets:config.targets,async read(t){
  const p=await config.resolve(t);if(t.providerKind!=='zuplo'||p.customerId!==t.customerId||p.instanceId!==t.instanceId||p.policyHash!==t.proposalHash)throw Error('zuplo_observation_binding_mismatch');
  const resource=await config.management.readConsumer(p.account,p.bucketId,p.consumerName);if(!resource)return null;
  for(const [key,value] of Object.entries({customer_id:p.customerId,instance_id:p.instanceId,approval_hash:p.approvalHash,policy_hash:p.policyHash}))if(resource.metadata[key]!==value)throw Error('zuplo_observation_owner_conflict');
  const active=await config.customerGatewayPolicy(p.instanceId);
  if(!active||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(active.revision)||createHash('sha256').update(canonical(active.policy)).digest('hex')!==p.policyHash)throw Error('zuplo_deployed_policy_mismatch');
  return {resourceId:resource.id,providerKind:'zuplo',providerIdentity:resource.name,accountOrTeamScope:p.account+'/'+p.bucketId,policy:active.policy,registryRevision:active.revision};
 }});
}
