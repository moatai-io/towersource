import {it,expect} from 'vitest';import {createHash} from 'node:crypto';import {validateGatewaySetup} from './customer-gateway-setup.js';
it('does not silently reinterpret CP logical Gateway policy as a numeric VM profile',()=>{
 const policy={profileVersion:'all-standard-apis-v1',enabledApiIds:['all-standard-apis'],quotaMode:'observe' as const};
 const policyHash=createHash('sha256').update(JSON.stringify({enabledApiIds:policy.enabledApiIds,profileVersion:policy.profileVersion,quotaMode:policy.quotaMode})).digest('hex');
 const input={intentId:'11111111-1111-4111-8111-111111111111',instanceId:'22222222-2222-4222-8222-222222222222',customerId:'fixture',approvalHash:'a'.repeat(64),policyHash,providerKind:'zuplo' as const,credentialId:'gateway'};
 expect(()=>validateGatewaySetup(input,{profileId:'tower-shared-api-v1',gatewayBaseUrl:'https://fixture.example',policy})).toThrow('gateway_setup_policy_invalid');
 const expanded={profileVersion:'1',enabledApiIds:['agent-store','apify','corepin','fc','naver','openai'],quotaMode:'observe' as const};
 // Expanding names without a new, explicit approval/hash mapping is not permitted either.
 expect(()=>validateGatewaySetup(input,{profileId:'tower-shared-api-v1',gatewayBaseUrl:'https://fixture.example',policy:expanded})).toThrow('gateway_setup_policy_invalid');
});
