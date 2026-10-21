import {queryOne} from '../../db/pg-repo.js';
/** Single SQL snapshot of VM-owned policy, not a Zuplo route/deployment claim. */
export async function readCustomerGatewayPolicy(input:{instanceId:string;profileId:string;credentialId:string;consumerRef:string},localInstance:()=>Promise<string>){
 if(await localInstance()!==input.instanceId)throw Error('gateway_policy_instance_mismatch');
 const row=await queryOne<{version:string;credential_id:string;consumer_ref:string;desired_state_hash:string;applied_state_hash:string;status:string;entries:{api_id:string;quota_mode:string}[]}>(`SELECT p.version,p.credential_id,p.consumer_ref,p.desired_state_hash,p.applied_state_hash,p.status,
 COALESCE((SELECT json_agg(json_build_object('api_id',e.api_id,'quota_mode',e.quota_mode) ORDER BY e.api_id) FROM gateway_profile_catalog_entries e WHERE e.profile_id=p.id AND e.enabled=true),'[]'::json) entries
 FROM gateway_profiles p WHERE p.id=$1`,[input.profileId]);
 if(!row||row.credential_id!==input.credentialId||row.consumer_ref!==input.consumerRef||row.status==='disabled'||!row.applied_state_hash||row.applied_state_hash!==row.desired_state_hash||!/^[a-f0-9]{64}$/.test(row.applied_state_hash)||!Array.isArray(row.entries)||!row.entries.length||row.entries.some(e=>e.quota_mode!=='observe'||typeof e.api_id!=='string'))throw Error('gateway_policy_not_applied');
 const version=String(row.version);if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(version))throw Error('gateway_policy_version_invalid');
 return {policy:{profileVersion:version,enabledApiIds:row.entries.map(e=>e.api_id).sort(),quotaMode:'observe' as const},revision:row.applied_state_hash};
}
