import type {ApprovedDelivery} from './central-delivery.js';
import {localLiteLlmManagement} from './litellm-management-http.js';
import {zuploManagementHttp} from './zuplo-management-http.js';
import {autoEnrollApprovedLiteLlmCustomer,readApprovedAutoLiteLlmCustomer,type AutoLiteLlmEnrollmentPolicy} from './litellm-auto-enrollment.js';
import {issueApprovedZuploKey,type ApprovedZuploKeyPolicy} from './zuplo-key-issuer.js';
/** Central-only composition of existing management clients. Caller MUST consume the
 * durable CP intent before issue. This module neither starts listeners nor registers routes.
 */
export function centralOutboundIssuers(config:{litellm:Parameters<typeof localLiteLlmManagement>[0];zuplo:Parameters<typeof zuploManagementHttp>[0]}){
 const lite=localLiteLlmManagement(config.litellm),gateway=zuploManagementHttp(config.zuplo);
 return {
 readLiteLlm:(input:ApprovedDelivery,policy:AutoLiteLlmEnrollmentPolicy)=>readApprovedAutoLiteLlmCustomer(input,policy,lite),
 async readZuplo(input:ApprovedDelivery,policy:ApprovedZuploKeyPolicy){
 if(input.providerKind!=='zuplo'||['customerId','instanceId','approvalHash','policyHash','credentialId'].some(k=>(input as any)[k]!==(policy as any)[k]))throw Error('zuplo_readback_policy_invalid');
 const row=await gateway.readConsumer(policy.account,policy.bucketId,policy.consumerName);
 if(!row||row.name!==policy.consumerName||row.metadata.customer_id!==input.customerId||row.metadata.instance_id!==input.instanceId||row.metadata.approval_hash!==input.approvalHash||row.metadata.policy_hash!==input.policyHash||row.metadata.delivery_intent_id!==input.intentId)throw Error('zuplo_readback_unverified');
 return {providerResourceId:row.id};
 },
 async issueLiteLlm(input:ApprovedDelivery,policy:AutoLiteLlmEnrollmentPolicy){const x=await autoEnrollApprovedLiteLlmCustomer(input,policy,lite);return {providerResourceId:x.providerResourceId,value:x.value};},
 issueZuplo:(input:ApprovedDelivery,policy:ApprovedZuploKeyPolicy)=>issueApprovedZuploKey(input,policy,gateway),
 };
}
