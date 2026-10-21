import {enrollmentObservationHttp,type ApprovedObservationTarget} from './enrollment-observation-http.js';
import {readApprovedAutoLiteLlmCustomer,type AutoLiteLlmEnrollmentPolicy} from './litellm-auto-enrollment.js';
import type {ApprovedDelivery} from './central-delivery.js';
import type {LiteLlmManagementPort} from './litellm-key-issuer.js';
/** Actual team inventory and exact team/key policy verification. Partial team creation is recovery, not absence. */
export function centralLiteLlmObservation(config:{token:string;targets:readonly ApprovedObservationTarget[];management:LiteLlmManagementPort;resolve(t:Readonly<ApprovedObservationTarget>):Promise<{delivery:ApprovedDelivery;policy:AutoLiteLlmEnrollmentPolicy}>}){
 return enrollmentObservationHttp({token:config.token,kind:'provider',targets:config.targets,async read(t){
  const {delivery:d,policy:p}=await config.resolve(t);
  if(t.providerKind!=='litellm'||d.providerKind!=='litellm'||d.customerId!==t.customerId||d.instanceId!==t.instanceId||d.policyHash!==t.proposalHash||['customerId','instanceId','approvalHash','policyHash','credentialId'].some(k=>d[k as keyof ApprovedDelivery]!==p[k as keyof AutoLiteLlmEnrollmentPolicy]))throw Error('litellm_observation_binding_mismatch');
  const raw:any=await config.management.request('/team/list','GET');const teams=Array.isArray(raw)?raw:raw?.teams;
  if(!Array.isArray(teams)||teams.length>1000||teams.some(x=>!x||typeof x.team_id!=='string'||typeof x.team_alias!=='string'))throw Error('litellm_observation_inventory_invalid');
  // Structured pagination must explicitly establish completeness.
  if(!Array.isArray(raw)&&((raw.total_count!==undefined&&raw.total_count!==teams.length)||(raw.total_pages!==undefined&&raw.total_pages>1)))throw Error('litellm_observation_inventory_incomplete');
  const matches=teams.filter(x=>x.team_id===p.teamId||x.team_alias===p.teamAlias);
  if(!matches.length)return null;if(matches.length!==1)throw Error('litellm_observation_conflict');
  const r=await readApprovedAutoLiteLlmCustomer(d,p,config.management);
  return {resourceId:r.providerResourceId,providerKind:'litellm',providerIdentity:p.teamId,accountOrTeamScope:p.teamId,policy:{budgetMicrousd:p.monthlyBudgetUsd*1000000,budgetDuration:p.budgetDuration,models:[...p.models]},registryRevision:d.policyHash};
 }});
}
