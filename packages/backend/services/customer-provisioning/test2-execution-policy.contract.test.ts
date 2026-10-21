import {it,expect} from 'vitest';import {execFileSync} from 'node:child_process';import {validateGatewaySetup} from './customer-gateway-setup.js';import {issueApprovedZuploKey} from './zuplo-key-issuer.js';import {autoEnrollApprovedLiteLlmCustomer} from './litellm-auto-enrollment.js';
const cp=process.env.CUSTOMER_GATEWAY_CP_SOURCE;
it.skipIf(!cp)('real CP translation satisfies product policies without widening approved models',async()=>{const {payload:p,executionHash}=JSON.parse(execFileSync(process.execPath,['--import','tsx','scripts/test2-execution-policy-probe.ts'],{cwd:cp,encoding:'utf8'}));
 const base={intentId:'11111111-1111-4111-8111-111111111111',customerId:p.customerId,instanceId:p.instanceId,approvalHash:executionHash};const z={...base,providerKind:'zuplo' as const,credentialId:p.gateway.credentialId,policyHash:p.gateway.policyHash};
 expect(()=>validateGatewaySetup(z,{profileId:p.gateway.profileId,gatewayBaseUrl:'https://fixture.example',policy:p.gateway.policy})).not.toThrow();
 const zr=await issueApprovedZuploKey(z,{...z,account:p.gateway.account,bucketId:p.gateway.bucketId,consumerName:p.gateway.consumerName},{consumerExists:async()=>false,createConsumer:async()=>({id:'csmr_fixture',name:p.gateway.consumerName,apiKeys:[{key:'synthetic-key'}]})});expect(zr.providerResourceId).toBe('csmr_fixture');
 const l={...base,providerKind:'litellm' as const,credentialId:p.litellm.credentialId,policyHash:p.litellm.policyHash};
 // If product shape validation passes, deliberate provider sentinel is reached. No network call.
 let reached=false;await expect(autoEnrollApprovedLiteLlmCustomer(l,{...l,...p.litellm},{request:async()=>{reached=true;throw Error('fixture-provider-stop');}})).rejects.toThrow();expect(reached).toBe(true);expect(p.litellm.models).toEqual(['gpt-6.1-sol']);
});
