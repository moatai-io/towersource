import {issueAndDeliverCustomerCredential} from './central-delivery.js';
import type {ApprovedDelivery} from './central-delivery.js';
import type {CentralLiteLlmRuntimeAuthority} from './central-litellm-runtime.js';
import type {CentralRelayHttpConfig} from './central-relay-http.js';
import {customerDeliveryTransport,type CustomerDeliveryTransportConfig} from './central-http-delivery.js';
import {issueApprovedZuploKey,type ApprovedZuploKeyPolicy,type ZuploManagementPort} from './zuplo-key-issuer.js';
export interface CentralZuploRuntimeAuthority extends Omit<CentralLiteLlmRuntimeAuthority,'approvedDelivery'> {
 approvedDelivery(input:ApprovedDelivery):Promise<{policy:ApprovedZuploKeyPolicy;receiver:CustomerDeliveryTransportConfig}>;
}
/** Provider-specific branch behind the shared consumed-intent relay; secret delivered directly to customer. */
export function centralZuploRuntime(config:{serviceToken:string;management:ZuploManagementPort;authority:CentralZuploRuntimeAuthority}):CentralRelayHttpConfig{
 const a=config.authority;
 if(config.serviceToken.length<32||typeof config.management.consumerExists!=='function'||typeof config.management.createConsumer!=='function'||['contractFor','authorizeContract','attest','consumeRelayIntent','approvedDelivery','verifyReceiver'].some(k=>typeof a[k as keyof CentralZuploRuntimeAuthority]!=='function'))throw Error('central_zuplo_runtime_unconfigured');
 return {serviceToken:config.serviceToken,contractFor:(h,k)=>a.contractFor(h,k),ports:{
  authorizeContract:(h,i)=>a.authorizeContract(h,i),attest:c=>a.attest(c),consumeRelayIntent:(h,i)=>a.consumeRelayIntent(h,i),
  async issueAndDeliver(_contract,input){
   if(input.providerKind!=='zuplo')throw Error('central_zuplo_provider_denied');
   const approved=await a.approvedDelivery(input);const policy=structuredClone(approved.policy),receiver=Object.freeze({...approved.receiver});const transport=customerDeliveryTransport(receiver);
   return issueAndDeliverCustomerCredential(input,{...transport,
    async consumeAndVerifyReceiver(i){await a.verifyReceiver(i,receiver);await transport.preflight(i);},
    issue:i=>issueApprovedZuploKey(i,policy,config.management),
   });
  }
 }};
}
