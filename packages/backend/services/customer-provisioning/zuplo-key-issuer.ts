import type {ApprovedDelivery} from './central-delivery.js';
export interface ApprovedZuploKeyPolicy {
 customerId:string;instanceId:string;approvalHash:string;policyHash:string;credentialId:string;
 account:string;bucketId:string;consumerName:string;
}
export interface ZuploManagementPort {
 /** Only confirmed absence may authorize creation; transport/auth errors must throw. */
 consumerExists(account:string,bucketId:string,name:string):Promise<boolean>;
 createConsumer(input:{account:string;bucketId:string;name:string;metadata:Record<string,string>}):Promise<{id:string;name:string;apiKeys:Array<{key:string}>}>;
}
/** Creation-only. Caller owns durable intent consumption and attested customer delivery.
 * Existing consumer requires readback/recovery, never key rotation or re-creation.
 */
export async function issueApprovedZuploKey(input:ApprovedDelivery,policy:ApprovedZuploKeyPolicy,management:ZuploManagementPort){
 const id=/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
 if(input.providerKind!=='zuplo'||['customerId','instanceId','approvalHash','policyHash','credentialId'].some(k=>input[k as keyof ApprovedDelivery]!==policy[k as keyof ApprovedZuploKeyPolicy])||![policy.account,policy.bucketId,policy.consumerName].every(v=>typeof v==='string'&&id.test(v)))throw Error('zuplo_issuance_policy_invalid');
 const exists=await management.consumerExists(policy.account,policy.bucketId,policy.consumerName);
 if(exists!==false)throw Error('zuplo_existing_or_unknown_consumer_recovery_required');
 let result:Awaited<ReturnType<ZuploManagementPort['createConsumer']>>;
 try{result=await management.createConsumer({account:policy.account,bucketId:policy.bucketId,name:policy.consumerName,metadata:{customer_id:input.customerId,instance_id:input.instanceId,approval_hash:input.approvalHash,policy_hash:input.policyHash,delivery_intent_id:input.intentId}});}catch{throw Error('zuplo_issuance_outcome_unknown_no_replay');}
 if(!result||!id.test(result.id)||result.name!==policy.consumerName||!Array.isArray(result.apiKeys)||result.apiKeys.length!==1||typeof result.apiKeys[0]?.key!=='string'||!result.apiKeys[0].key.trim())throw Error('zuplo_issuance_outcome_unknown_no_replay');
 return {providerResourceId:result.id,value:result.apiKeys[0].key};
}
