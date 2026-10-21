import {it,expect,vi} from 'vitest';
vi.mock('../../db/pg-repo.js',()=>({queryOne:vi.fn()}));
vi.mock('../credential-vault/credential-vault-service.js',()=>({resolveProjectCredentialSecretValue:vi.fn(),upsertApiKeyCredential:vi.fn()}));
vi.mock('./local-vault-access.js',()=>({assertCustomerLocalVaultAccess:vi.fn()}));
import {queryOne} from '../../db/pg-repo.js';import {resolveProjectCredentialSecretValue} from '../credential-vault/credential-vault-service.js';import {readCustomerVaultDelivery,assertCustomerVaultDestinationAbsent} from './customer-vault-readback.js';
const input={intentId:'11111111-1111-4111-8111-111111111111',customerId:'fixture',instanceId:'22222222-2222-4222-8222-222222222222',approvalHash:'a'.repeat(64),policyHash:'b'.repeat(64),providerKind:'zuplo' as const,credentialId:'fixture-key'};
const binding={customerId:input.customerId,instanceId:input.instanceId,projectId:'33333333-3333-4333-8333-333333333333',actorUserId:7};
const row=()=>({kind:'api_key',provider:'zuplo',scope:'workspace',project_id:null,secret_name:'VAULT_'+'A'.repeat(56),default_env_name:'ZUPLO_VIRTUAL_KEY',enabled:true,metadata:{...input,deliveryIntentId:input.intentId,providerResourceId:'resource-1'}});
it('readback verifies material via canonical resolver and never returns the key',async()=>{vi.mocked(queryOne).mockResolvedValueOnce(row());vi.mocked(resolveProjectCredentialSecretValue).mockResolvedValueOnce({credentialId:input.credentialId,provider:'zuplo',kind:'api_key',secretName:'VAULT_'+'A'.repeat(56),value:'fixture-private-value'});const r=await readCustomerVaultDelivery(input,binding);expect(r.stored).toBe(true);expect(JSON.stringify(r)).not.toContain('fixture-private-value');});
it('wrong policy, missing material and conflicting destination fail closed',async()=>{vi.mocked(queryOne).mockResolvedValueOnce({...row(),metadata:{...row().metadata,policyHash:'c'.repeat(64)}});await expect(readCustomerVaultDelivery(input,binding)).rejects.toThrow('readback_mismatch');vi.mocked(queryOne).mockResolvedValueOnce(row());vi.mocked(resolveProjectCredentialSecretValue).mockResolvedValueOnce(undefined);await expect(readCustomerVaultDelivery(input,binding)).rejects.toThrow('material_missing');vi.mocked(queryOne).mockResolvedValueOnce({id:'existing-key'});await expect(assertCustomerVaultDestinationAbsent(input,binding)).rejects.toThrow('destination_conflict');});
it('rejects a guessed storage reference even when all delivery metadata matches',async()=>{
 vi.mocked(queryOne).mockResolvedValueOnce({...row(),secret_name:'LITELLM_API_KEY'});await expect(readCustomerVaultDelivery(input,binding)).rejects.toThrow('readback_mismatch');
});
it('denies a Vault row/reference race instead of trusting an earlier name',async()=>{
 vi.mocked(queryOne).mockResolvedValueOnce(row());vi.mocked(resolveProjectCredentialSecretValue).mockResolvedValueOnce({credentialId:input.credentialId,provider:'zuplo',kind:'api_key',secretName:'VAULT_'+'B'.repeat(56),value:'fixture-private-value'});await expect(readCustomerVaultDelivery(input,binding)).rejects.toThrow('storage_reference_changed');
});
