import {fileCentralIssuerAuthority,fileCentralZuploAuthority} from './central-issuer-authority.js';
import type {CustomerRelayEnrollmentAuthority} from './customer-relay-enrollment-ports.js';
import type {CentralRelayTransportConfig} from './central-relay-transport.js';
import {centralRelayContractHash} from './central-relay.js';
/** Reuses strict private-file validation for operator-published customer relay contracts.
 * Customer copies contain policy/contract only; central management credentials are never included.
 */
export function publishedCustomerRelayAuthority(config:{approvalDirectory:string;intentDirectory:string;endpoint:string;serviceToken:string;readback:CustomerRelayEnrollmentAuthority['readback']}):CustomerRelayEnrollmentAuthority{
 const never=async()=>{throw Error('customer_cannot_execute_central_authority');};
 const options={approvalDirectory:config.approvalDirectory,intentDirectory:config.intentDirectory,attest:never,verifyReceiver:never};
 const authorities={litellm:fileCentralIssuerAuthority(options),zuplo:fileCentralZuploAuthority(options)};
 return {readback:config.readback,async approved(request,binding){
  if(request.providerKind!=='zuplo'&&request.providerKind!=='litellm')throw Error('customer_provider_missing');
  const a=authorities[request.providerKind],contract=await a.contractFor(request.approvalHash,request.providerKind);
  if(contract.instanceId!==binding.instanceId||contract.customerId!==binding.customerId)throw Error('customer_published_binding_mismatch');
  const intentId=await a.originalIntent(request.approvalHash,request.providerKind);
  if(request.operation==='enrollment-issue'&&request.intentId!==intentId)throw Error('customer_published_intent_mismatch');
  const delivery={intentId,customerId:contract.customerId,instanceId:contract.instanceId,approvalHash:contract.approvalHash,policyHash:contract.policyHash,providerKind:contract.providerKind,credentialId:contract.credentialId};
  await a.approvedDelivery(delivery);
  const transport:CentralRelayTransportConfig={endpoint:config.endpoint,serviceToken:config.serviceToken,contractHash:centralRelayContractHash(contract)};
  return {delivery,contract,transport};
 }};
}
