import type {ApprovedDelivery,DeliveryReceipt} from './central-delivery.js';
import type {CentralRelayContract} from './central-relay.js';
import {centralRelayContractHash} from './central-relay.js';
import {centralRelayTransport,type CentralRelayTransportConfig} from './central-relay-transport.js';
import type {CustomerRuntimeBinding,CustomerServiceRequest} from './service-boundary.js';
import type {CustomerEnrollmentServicePorts,EnrollmentTarget} from './enrollment-handler.js';
export interface CustomerRelayEnrollmentAuthority {
 approved(request:CustomerServiceRequest,binding:CustomerRuntimeBinding):Promise<{delivery:ApprovedDelivery;contract:CentralRelayContract;transport:CentralRelayTransportConfig}>;
 /** Fresh local Vault metadata/ACL readback; never return secret values. */
 readback(delivery:ApprovedDelivery,binding:CustomerRuntimeBinding):Promise<DeliveryReceipt>;
}
/** Customer holds relay token only, never provider management credentials. Supports both approved providers. */
export function customerRelayEnrollmentPorts(authority:CustomerRelayEnrollmentAuthority,fetcher:typeof fetch=fetch):CustomerEnrollmentServicePorts{
 async function resolve(request:CustomerServiceRequest,binding:CustomerRuntimeBinding){
  const x=structuredClone(await authority.approved(request,binding)),d=x.delivery;
  if(d.customerId!==binding.customerId||d.instanceId!==binding.instanceId||d.approvalHash!==request.approvalHash||d.providerKind!==request.providerKind||(request.operation==='enrollment-issue'&&d.intentId!==request.intentId))throw Error('customer_relay_binding_mismatch');
  for(const k of ['customerId','instanceId','approvalHash','policyHash','providerKind','credentialId'] as const)if(x.contract[k]!==d[k])throw Error('customer_relay_contract_mismatch');
  if(centralRelayContractHash(x.contract)!==x.transport.contractHash)throw Error('customer_relay_contract_mismatch');return x;
 }
 async function load(t:EnrollmentTarget,b:CustomerRuntimeBinding,intentId?:string){
  const approvalHash=(t as EnrollmentTarget & {approvalHash:string}).approvalHash;
  const x=await resolve({customerId:b.customerId,instanceId:b.instanceId,approvalHash,providerKind:t.providerKind,operation:intentId?'enrollment-issue':'enrollment-readback',...(intentId?{intentId}:{})},b);
  if(x.delivery.credentialId!==t.credentialId||x.delivery.policyHash!==t.policyHash)throw Error('customer_relay_target_changed');return x;
 }
 return {
  async approvedTarget(request,binding){const {delivery:d}=await resolve(request,binding);return Object.freeze({providerKind:d.providerKind,credentialId:d.credentialId,policyHash:d.policyHash,approvalHash:d.approvalHash});},
  async issueAndStore(t,b,intentId){const x=await load(t,b,intentId);await centralRelayTransport(x.transport,fetcher)(x.contract,x.delivery);},
  async readback(t,b){const {delivery:d}=await load(t,b);const r=await authority.readback(d,b);
   if(!r||Object.keys(d).some(k=>r[k as keyof ApprovedDelivery]!==d[k as keyof ApprovedDelivery])||r.stored!==true||typeof r.providerResourceId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(r.providerResourceId))throw Error('customer_relay_readback_mismatch');
   return {customerId:r.customerId,instanceId:r.instanceId,providerKind:r.providerKind,credentialId:r.credentialId,policyHash:r.policyHash,providerResourceId:r.providerResourceId,stored:true};
  }
 };
}
