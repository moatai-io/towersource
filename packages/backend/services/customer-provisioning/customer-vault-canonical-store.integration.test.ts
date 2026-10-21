import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({one:vi.fn(),query:vi.fn(),execute:vi.fn(),secret:vi.fn(),access:vi.fn(),configure:vi.fn(),verify:vi.fn(),activate:vi.fn(),resolved:vi.fn()}));
vi.mock('../../db/pg-repo.js',()=>({queryOne:m.one,query:m.query,execute:m.execute,transaction:vi.fn(),withClient:vi.fn()}));
vi.mock('../secret/secret-store.js',()=>({getSecretForProjectBinding:m.resolved,getSecretForLegacyGwsBinding:vi.fn(),setSecret:m.secret}));
vi.mock('../credential-vault/credential-management-access.js',()=>({assertCredentialManagementAccess:m.access}));
vi.mock('../ai/litellm-setup.js',()=>({configureCustomerLiteLLMFromVault:m.configure,assertCustomerLiteLLMBinding:m.verify,activateCustomerLiteLLMRuntime:m.activate}));
import {customerVaultReceiver} from './customer-vault-receiver.js';
import {readCustomerVaultDelivery,readCustomerVaultSecretReference,assertCustomerVaultDestinationAbsent} from './customer-vault-readback.js';
const input={intentId:'11111111-1111-4111-8111-111111111111',customerId:'fixture',instanceId:'22222222-2222-4222-8222-222222222222',approvalHash:'a'.repeat(64),policyHash:'b'.repeat(64),providerKind:'litellm' as const,credentialId:'fixture-inference'};
const b={customerId:input.customerId,instanceId:input.instanceId,projectId:'33333333-3333-4333-8333-333333333333',actorUserId:7};
beforeEach(()=>{vi.resetAllMocks();});
it('uses the actual canonical upsert result, not the caller env name, end to end',async()=>{
 let stored:any;
 m.one.mockImplementation(async(sql:string,args:any[])=>{
  if(sql.startsWith('INSERT INTO workspace_credentials')){stored={id:args[0],kind:'api_key',provider:args[1],scope:'workspace',project_id:null,secret_name:args[3],default_env_name:args[4],metadata:JSON.parse(args[7]),enabled:true};return stored;}
  if(sql.includes('SELECT c.id AS credential_id'))return stored?{...stored,credential_id:stored.id}:undefined;
  if(sql.includes('FROM workspace_credentials'))return stored;
  if(sql.includes('FROM public.projects'))return {id:b.projectId};
  return undefined;
 });
 m.resolved.mockResolvedValue('synthetic-key-material');
 const receiver=customerVaultReceiver({async resolve(){return b;},assertDestinationAbsent:assertCustomerVaultDestinationAbsent,async consume(){},readback:readCustomerVaultDelivery,secretReference:readCustomerVaultSecretReference},undefined,{async approvedBaseUrl(){return 'https://router.fixture/v1';}});
 await receiver.verifyLocalAuthority(input);await receiver.store({...input,providerResourceId:'fixture-resource',value:'synthetic-key-material'});
 expect(stored.secret_name).toMatch(/^VAULT_[A-F0-9]{56}$/);expect(stored.secret_name).not.toBe('LITELLM_API_KEY');expect(m.configure).toHaveBeenCalledWith({baseUrl:'https://router.fixture/v1',actorUserId:7,secretName:stored.secret_name});expect(m.secret).toHaveBeenCalledWith(expect.objectContaining({name:stored.secret_name,scope:'global'}));
 const receipt=await receiver.readback(input);expect(receipt).toEqual({...input,providerResourceId:'fixture-resource',stored:true});expect(m.verify).toHaveBeenCalledWith(expect.objectContaining({secretName:stored.secret_name}));expect(JSON.stringify(receipt)).not.toContain('synthetic-key-material');expect(m.activate).toHaveBeenCalledOnce();
});
