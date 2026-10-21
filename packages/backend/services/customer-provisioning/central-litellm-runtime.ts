import type {ApprovedDelivery,CentralIssuancePorts} from './central-delivery.js';
import {autoEnrollAndDeliverLiteLlmCustomer,type AutoLiteLlmEnrollmentPolicy} from './litellm-auto-enrollment.js';
import type {LiteLlmManagementPort} from './litellm-key-issuer.js';
import type {CentralRelayContract,CentralRelayPorts} from './central-relay.js';
import type {CentralRelayHttpConfig} from './central-relay-http.js';
import {customerDeliveryTransport,type CustomerDeliveryTransportConfig} from './central-http-delivery.js';
export interface CentralLiteLlmRuntimeAuthority extends Pick<CentralRelayPorts,'authorizeContract'|'attest'|'consumeRelayIntent'> {
 contractFor(approvalHash:string,providerKind:'zuplo'|'litellm'):Promise<CentralRelayContract>;
 /** Published exact policy, not inferred from incoming request. */
 approvedDelivery(input:ApprovedDelivery):Promise<{policy:AutoLiteLlmEnrollmentPolicy;receiver:CustomerDeliveryTransportConfig}>;
 /** Independently attest receiver identity/policy/Vault absence BEFORE external issuance. */
 verifyReceiver(input:ApprovedDelivery,receiver:CustomerDeliveryTransportConfig):Promise<void>;
}
/** Concrete composition; deployment supplies durable authority, never request-selected URLs/master keys. */
export function centralLiteLlmRuntime(config:{serviceToken:string;management:LiteLlmManagementPort;authority:CentralLiteLlmRuntimeAuthority}):CentralRelayHttpConfig {
 const a=config.authority;
 if(config.serviceToken.length<32||typeof config.management.request!=='function'||['contractFor','authorizeContract','attest','consumeRelayIntent','approvedDelivery','verifyReceiver'].some(k=>typeof a[k as keyof CentralLiteLlmRuntimeAuthority]!=='function'))throw Error('central_litellm_runtime_unconfigured');
 return {serviceToken:config.serviceToken,contractFor:(hash,kind)=>a.contractFor(hash,kind),ports:{
  authorizeContract:(hash,input)=>a.authorizeContract(hash,input),attest:contract=>a.attest(contract),consumeRelayIntent:(hash,input)=>a.consumeRelayIntent(hash,input),
  async issueAndDeliver(_contract,input){
   if(input.providerKind!=='litellm')throw Error('central_litellm_provider_denied');
   const approved=await a.approvedDelivery(input);const policy=structuredClone(approved.policy),receiver=Object.freeze({...approved.receiver});
   const transport=customerDeliveryTransport(receiver);
   const ports:Omit<CentralIssuancePorts,'issue'>={...transport,consumeAndVerifyReceiver:async delivery=>{await a.verifyReceiver(delivery,receiver);await transport.preflight(delivery);}};
   return autoEnrollAndDeliverLiteLlmCustomer(input,policy,config.management,ports);
  },
 }};
}
