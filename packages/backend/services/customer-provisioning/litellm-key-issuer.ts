import type {ApprovedDelivery} from './central-delivery.js';
export interface ApprovedLiteLlmKeyPolicy {
 customerId:string;instanceId:string;approvalHash:string;policyHash:string;credentialId:string;
 teamId:string;keyAlias:string;models:string[];monthlyBudgetUsd:50;budgetDuration:string;
}
export interface LiteLlmManagementPort {
 /** Central container-local authenticated client. No master key is returned by this interface. */
 request(path:string,method:'GET'|'POST',body?:object):Promise<unknown>;
}
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
/** Creation-only adapter. Existing Team must independently match approved policy; no implicit Team creation/rotation. */
export async function issueApprovedLiteLlmKey(input:ApprovedDelivery,policy:ApprovedLiteLlmKeyPolicy,management:LiteLlmManagementPort):Promise<{providerResourceId:string;value:string}>{
 const safe=/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
 if(input.providerKind!=='litellm'||['customerId','instanceId','approvalHash','policyHash','credentialId'].some(k=>input[k as keyof ApprovedDelivery]!==policy[k as keyof ApprovedLiteLlmKeyPolicy])||!safe.test(policy.teamId)||!safe.test(policy.keyAlias)||policy.monthlyBudgetUsd!==50||!['1mo','monthly'].includes(policy.budgetDuration)||!Array.isArray(policy.models)||policy.models.length===0||policy.models.length>32||new Set(policy.models).size!==policy.models.length||policy.models.some(x=>!safe.test(x)))throw Error('litellm_issuance_policy_invalid');
 let info:unknown;
 try{info=await management.request('/team/info?team_id='+encodeURIComponent(policy.teamId),'GET');}catch{throw Error('litellm_team_readback_unavailable');}
 const team=object(info)&&object(info.team_info)?info.team_info:undefined;
 const models=team?.models;
 if(!team||team.team_id!==policy.teamId||team.max_budget!==50||team.budget_duration!==policy.budgetDuration||!Array.isArray(models)||models.length!==policy.models.length||!policy.models.every(x=>models.includes(x)))throw Error('litellm_team_policy_mismatch');
 // Explicitly exhaustive pagination is required. A partial list cannot prove alias absence.
 const keys=await management.request('/key/list?return_full_object=true&team_id='+encodeURIComponent(policy.teamId),'GET');
 if(!object(keys)||!Array.isArray(keys.keys)||keys.complete!==true)throw Error('litellm_key_list_incomplete');
 if(keys.keys.some(x=>!object(x)||x.team_id!==policy.teamId||typeof x.key_alias!=='string'))throw Error('litellm_key_list_invalid');
 if(keys.keys.some(x=>(x as Record<string,unknown>).key_alias===policy.keyAlias))throw Error('litellm_existing_key_requires_rotation_approval');
 let created:unknown;
 try{created=await management.request('/key/generate','POST',{team_id:policy.teamId,key_alias:policy.keyAlias,models:[...policy.models],max_budget:50,budget_duration:policy.budgetDuration,metadata:{customer_id:input.customerId,instance_id:input.instanceId,approval_hash:input.approvalHash,policy_hash:input.policyHash,delivery_intent_id:input.intentId}});}catch{throw Error('litellm_key_outcome_unknown_no_replay');}
 // Resource ID must not be derived from the secret; absent non-secret ID requires recovery.
 if(!object(created)||typeof created.key!=='string'||!created.key.trim()||typeof created.key_id!=='string'||!safe.test(created.key_id)||created.team_id!==policy.teamId||created.key_alias!==policy.keyAlias)throw Error('litellm_key_outcome_unknown_no_replay');
 return {providerResourceId:created.key_id,value:created.key};
}
