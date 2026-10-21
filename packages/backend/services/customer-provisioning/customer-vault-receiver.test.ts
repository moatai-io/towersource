import {it,expect,vi} from 'vitest';
vi.mock('../ai/litellm-setup.js',()=>({configureCustomerLiteLLMFromVault:vi.fn(),assertCustomerLiteLLMBinding:vi.fn(),activateCustomerLiteLLMRuntime:vi.fn()}));
vi.mock('../credential-vault/credential-vault-service.js',()=>({upsertApiKeyCredential:vi.fn()}));vi.mock('./local-vault-access.js',()=>({assertCustomerLocalVaultAccess:vi.fn()}));
import {customerVaultReceiver} from './customer-vault-receiver.js';import type {ApprovedDelivery} from './central-delivery.js';
const input:ApprovedDelivery={intentId:'11111111-1111-4111-8111-111111111111',customerId:'fixture',instanceId:'22222222-2222-4222-8222-222222222222',approvalHash:'a'.repeat(64),policyHash:'b'.repeat(64),providerKind:'zuplo',credentialId:'fixture-key'};
it('stores only customer virtual key under canonical workspace ACL',async()=>{const writes:any[]=[];const authority={async resolve(){return {customerId:'fixture',instanceId:input.instanceId,projectId:'33333333-3333-4333-8333-333333333333',actorUserId:7};},async assertDestinationAbsent(){},async consume(){},async readback(){return {...input,providerResourceId:'resource-1',stored:true as const};}};const r=customerVaultReceiver(authority,{async store(x){writes.push(x);return {} as any;},async access(){}});await r.store({...input,providerResourceId:'resource-1',value:'fixture-only-secret'});expect(writes[0].scope).toBe('workspace');expect(writes[0].projectId).toBeUndefined();expect(writes[0].defaultEnvName).toBe('ZUPLO_VIRTUAL_KEY');expect(writes[0].actorUserId).toBe(7);expect(JSON.stringify(await r.readback(input))).not.toContain('fixture-only-secret');});
it('wrong local instance or denied canonical ACL cannot store',async()=>{let writes=0;const authority={async resolve(){return {customerId:'fixture',instanceId:'44444444-4444-4444-8444-444444444444',projectId:'fixture',actorUserId:7};},async assertDestinationAbsent(){},async consume(){},async readback(){return {...input,providerResourceId:'resource-1',stored:true as const};}};const r=customerVaultReceiver(authority,{async store(){writes++;return {secret_name:'VAULT_'+'A'.repeat(56)} as any;},async access(){}});await expect(r.store({...input,providerResourceId:'resource-1',value:'fixture'})).rejects.toThrow('instance_mismatch');expect(writes).toBe(0);});

it('binds LiteLLM inference to the same Vault reference after store and verifies readback',async()=>{
 const x={...input,providerKind:'litellm' as const};const steps:string[]=[];
 const b={customerId:x.customerId,instanceId:x.instanceId,projectId:'33333333-3333-4333-8333-333333333333',actorUserId:7};
 const authority={async resolve(){return b;},async assertDestinationAbsent(){},async consume(){},async secretReference(){return 'VAULT_'+'A'.repeat(56);},async readback(){steps.push('vault-readback');return {...x,providerResourceId:'resource-1',stored:true as const};}};
 const configure=vi.fn(async config=>{steps.push('configure');expect(config.actorUserId).toBe(7);expect(config.secretName).toBe('VAULT_'+'A'.repeat(56));return {restartRequired:true as const};});
 const verify=vi.fn(()=>{steps.push('binding-readback');});
 const r=customerVaultReceiver(authority,{async store(v){steps.push('store');expect(v.defaultEnvName).toBe('LITELLM_API_KEY');return {secret_name:'VAULT_'+'A'.repeat(56)} as any;},async access(){},configure,verify,async activate(){steps.push('activate');}},{async approvedBaseUrl(){return 'https://router.example/v1';}});
 await r.verifyLocalAuthority(x);await r.store({...x,providerResourceId:'resource-1',value:'fixture-only-secret'});
 expect(await r.readback(x)).toEqual({...x,providerResourceId:'resource-1',stored:true});
 expect(steps).toEqual(['store','configure','activate','vault-readback','binding-readback']);expect(JSON.stringify(configure.mock.calls)).not.toContain('fixture-only-secret');
});
it('fails closed for LiteLLM without an approved local inference endpoint',async()=>{
 const x={...input,providerKind:'litellm' as const};let writes=0;
 const authority={async resolve(){return {customerId:x.customerId,instanceId:x.instanceId,projectId:'fixture',actorUserId:7};},async assertDestinationAbsent(){},async consume(){},async secretReference(){return 'VAULT_'+'A'.repeat(56);},async readback(){return {...x,providerResourceId:'resource-1',stored:true as const};}};
 const r=customerVaultReceiver(authority,{async store(){writes++;return {secret_name:'VAULT_'+'A'.repeat(56)} as any;},async access(){}});
 await expect(r.verifyLocalAuthority(x)).rejects.toThrow('setup_unavailable');await expect(r.store({...x,providerResourceId:'resource-1',value:'fixture'})).rejects.toThrow('setup_unavailable');expect(writes).toBe(0);
});
it('does not report enrollment success when post-Vault configuration fails',async()=>{
 const x={...input,providerKind:'litellm' as const};let writes=0;
 const authority={async resolve(){return {customerId:x.customerId,instanceId:x.instanceId,projectId:'fixture',actorUserId:7};},async assertDestinationAbsent(){},async consume(){},async secretReference(){return 'VAULT_'+'A'.repeat(56);},async readback(){return {...x,providerResourceId:'resource-1',stored:true as const};}};
 const r=customerVaultReceiver(authority,{async store(){writes++;return {secret_name:'VAULT_'+'A'.repeat(56)} as any;},async access(){},async configure(){throw Error('setup-failed');},verify(){throw Error('binding-missing');}},{async approvedBaseUrl(){return 'https://router.example/v1';}});
 await expect(r.store({...x,providerResourceId:'resource-1',value:'fixture'})).rejects.toThrow('setup-failed');expect(writes).toBe(1);await expect(r.readback(x)).rejects.toThrow('binding-missing');
});
it('never fabricates an inference storage reference from credential IDs',async()=>{
 const x={...input,providerKind:'litellm' as const};const configure=vi.fn();const authority={async resolve(){return {customerId:x.customerId,instanceId:x.instanceId,projectId:'fixture',actorUserId:7};},async assertDestinationAbsent(){},async consume(){},async readback(){return {...x,providerResourceId:'resource-1',stored:true as const};}};
 const r=customerVaultReceiver(authority,{async store(){return {secret_name:'LITELLM_API_KEY'} as any;},async access(){},configure},{async approvedBaseUrl(){return 'https://router.fixture/v1';}});
 await expect(r.store({...x,providerResourceId:'resource-1',value:'fixture'})).rejects.toThrow('storage_reference_unverified');expect(configure).not.toHaveBeenCalled();
});
it('validates the canonical Vault credential ID before any issuance preflight',async()=>{
 const resolve=vi.fn();const authority={resolve,async assertDestinationAbsent(){},async consume(){},async readback(){return {...input,providerResourceId:'resource-1',stored:true as const};}};
 const r=customerVaultReceiver(authority,{async store(){return {} as any;},async access(){}});await expect(r.verifyLocalAuthority({...input,credentialId:'UpperCase.Credential'})).rejects.toThrow('credential_id_invalid');expect(resolve).not.toHaveBeenCalled();
});
it('passes installed GPT profile to Vault-backed configuration without exposing key',async()=>{
 const x={...input,providerKind:'litellm' as const};const configure=vi.fn(async()=>({restartRequired:true as const}));
 const authority={async resolve(){return {customerId:x.customerId,instanceId:x.instanceId,projectId:'fixture',actorUserId:7};},async assertDestinationAbsent(){},async consume(){},async readback(){return {...x,providerResourceId:'r',stored:true as const};}};
 const r=customerVaultReceiver(authority,{async store(){return {secret_name:'VAULT_'+'A'.repeat(56)} as any;},async access(){},configure,verify(){},async activate(){}},{async approvedBaseUrl(){return 'https://router.fixture/v1';},async approvedProfile(){return 'gpt-only';}});
 await r.store({...x,providerResourceId:'r',value:'fixture-secret'});
 expect(configure).toHaveBeenCalledWith(expect.objectContaining({customerProfile:'gpt-only',secretName:'VAULT_'+'A'.repeat(56)}));expect(JSON.stringify(configure.mock.calls)).not.toContain('fixture-secret');
});
it('Gateway store then apply then readback verification; apply failure leaves key for recovery, no duplicate store',async()=>{
 const events:string[]=[];let present=false;
 const a={async resolve(){return {customerId:input.customerId,instanceId:input.instanceId,projectId:'fixture',actorUserId:7};},async assertDestinationAbsent(){if(present)throw Error('exists');},async consume(){},async readback(){return {...input,providerResourceId:'resource-1',stored:true as const};}};
 const store=vi.fn(async()=>{events.push('store');present=true;return {} as any;});const gateway={async preflight(){events.push('preflight');},async apply(){events.push('apply');throw Error('profile failure');},async verify(){events.push('verify');}};
 const p=customerVaultReceiver(a,{access:async()=>{},store} as any,undefined,gateway);await p.verifyLocalAuthority(input);
 await expect(p.store({...input,providerResourceId:'resource-1',value:'fixture-secret'})).rejects.toThrow('profile failure');
 await expect(p.store({...input,providerResourceId:'resource-1',value:'fixture-secret'})).rejects.toThrow('exists');expect(store).toHaveBeenCalledOnce();expect(events).toEqual(['preflight','preflight','store','apply','preflight']);
});
