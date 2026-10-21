import { describe, expect, it } from 'vitest';
import type { ApprovedDelivery } from './central-delivery.js';
import { type CentralIssuancePorts } from './central-delivery.js';
import { autoEnrollApprovedLiteLlmCustomer, autoEnrollAndDeliverLiteLlmCustomer, readApprovedAutoLiteLlmCustomer, type AutoLiteLlmEnrollmentPolicy } from './litellm-auto-enrollment.js';
import type { LiteLlmManagementPort } from './litellm-key-issuer.js';

const input: ApprovedDelivery = { intentId: '11111111-1111-4111-8111-111111111111', customerId: 'fixture', instanceId: '22222222-2222-4222-8222-222222222222', approvalHash: 'a'.repeat(64), policyHash: 'b'.repeat(64), providerKind: 'litellm', credentialId: 'fixture-inference' };
const policy: AutoLiteLlmEnrollmentPolicy = { ...input, teamId: 'fixture-team', teamAlias: 'fixture-team', keyAlias: 'fixture-vm-key', models: ['gpt-6.1-sol', '~deepseek/deepseek-pro-latest', 'z-ai/glm-5.3'], monthlyBudgetUsd: 50, budgetDuration: '30d' };
const metadata = () => ({ customer_id: input.customerId, instance_id: input.instanceId, approval_hash: input.approvalHash, policy_hash: input.policyHash });
function fixture(options: { existingTeam?: boolean; teamMismatch?: boolean; keyExists?: boolean; incompleteKeys?: boolean; failTeam?: boolean; failKey?: boolean; keyReadbackMismatch?: boolean; missingModel?: boolean; noResourceId?: boolean } = {}) {
  const calls: Array<{ path: string; method: string; body?: object }> = [];
  const team = { team_id: policy.teamId, team_alias: policy.teamAlias, models: policy.models, max_budget: 50, budget_duration: '30d', metadata: metadata(), blocked: false };
  const key = { team_id: policy.teamId, key_alias: policy.keyAlias, models: policy.models, max_budget: 50, budget_duration: '30d', metadata: { ...metadata(), credential_id: policy.credentialId }, blocked: false };
  let teamCreated = !!options.existingTeam, keyCreated = false;
  const management: LiteLlmManagementPort = { async request(path, method, body) {
    calls.push({ path, method, body });
    if (path === '/models') return { data: policy.models.filter(id => !options.missingModel || id !== 'z-ai/glm-5.3').map(id => ({ id })) };
    if (path === '/team/list') return teamCreated ? [{ ...team, max_budget: options.teamMismatch ? 500 : 50 }] : [];
    if (path === '/team/new') {
      if (options.failTeam) throw new Error('provider ambiguous body intentionally not returned');
      teamCreated = true;return team;
    }
    if (path.startsWith('/team/info?')) return { team_info: team };
    if (path.startsWith('/key/list?')) {
      if (options.incompleteKeys) return { keys: [], total_count: 2, total_pages: 2 };
      const keys = options.keyExists || keyCreated ? [{ ...key, max_budget: options.keyReadbackMismatch ? 500 : 50 }] : [];
      return { keys, total_count: keys.length, total_pages: 1 };
    }
    if (path === '/key/generate') {
      if (options.failKey) throw new Error('provider supplied secret-looking response is not propagated');
      keyCreated = true;return { key: 'synthetic-private-key', team_id: policy.teamId, key_alias: policy.keyAlias, ...(options.noResourceId ? {} : { token_id: 'token-fixture' }) };
    }
    throw new Error('unexpected management path');
  } };
  return { calls, management };
}

describe('approved automatic LiteLLM Team/key enrollment', () => {
  it('creates Team then key once with exact models, hard budget and independent readback', async () => {
    const f = fixture();const r = await autoEnrollApprovedLiteLlmCustomer(input, policy, f.management);
    expect(r).toMatchObject({ teamCreated: true, teamId: policy.teamId, providerResourceId: policy.keyAlias, value: 'synthetic-private-key' });
    expect(f.calls.filter(x => x.method === 'POST').map(x => x.path)).toEqual(['/team/new', '/key/generate']);
    for (const x of f.calls.filter(x => x.method === 'POST')) expect(x.body).toMatchObject({ models: policy.models, max_budget: 50, budget_duration: '30d' });
    expect(f.calls.at(-1)?.path).toContain('/key/list?');
  });
  it('adopts only an exact existing customer Team and never updates it', async () => {
    const f = fixture({ existingTeam: true });expect((await autoEnrollApprovedLiteLlmCustomer(input, policy, f.management)).teamCreated).toBe(false);
    expect(f.calls.some(x => x.path === '/team/new')).toBe(false);
  });
  it('rejects a Team budget mismatch instead of silently modifying a shared team', async () => {
    const f = fixture({ existingTeam: true, teamMismatch: true });await expect(autoEnrollApprovedLiteLlmCustomer(input, policy, f.management)).rejects.toThrow('team_policy_conflict');
    expect(f.calls.filter(x => x.method === 'POST')).toHaveLength(0);
  });
  it('blocks key rotation, incomplete inventory and visibility mismatch before key generation', async () => {
    for (const options of [{ existingTeam: true, keyExists: true }, { existingTeam: true, incompleteKeys: true }, { missingModel: true }]) {
      const f = fixture(options);await expect(autoEnrollApprovedLiteLlmCustomer(input, policy, f.management)).rejects.toThrow();
      expect(f.calls.some(x => x.path === '/key/generate')).toBe(false);
    }
  });
  it('rejects incorrect customer binding before all management requests', async () => {
    const f = fixture();await expect(autoEnrollApprovedLiteLlmCustomer(input, { ...policy, instanceId: 'wrong' }, f.management)).rejects.toThrow('policy_invalid');expect(f.calls).toHaveLength(0);
  });
  it('keeps all three exact model IDs and rejects duplicate or invented aliases', async () => {
    for (const models of [['gpt-6.1-sol', 'deepseek-pro-latest', 'glm-5.3'], [...policy.models, policy.models[0]]]) {
      const f = fixture();await expect(autoEnrollApprovedLiteLlmCustomer(input, { ...policy, models }, f.management)).rejects.toThrow('policy_invalid');expect(f.calls).toHaveLength(0);
    }
  });
  it('never retries an ambiguous Team or key creation', async () => {
    const team = fixture({ failTeam: true });await expect(autoEnrollApprovedLiteLlmCustomer(input, policy, team.management)).rejects.toThrow('unknown_no_replay');expect(team.calls.filter(x => x.path === '/team/new')).toHaveLength(1);
    const key = fixture({ existingTeam: true, failKey: true });await expect(autoEnrollApprovedLiteLlmCustomer(input, policy, key.management)).rejects.toThrow('unknown_no_replay');expect(key.calls.filter(x => x.path === '/key/generate')).toHaveLength(1);
  });
  it('handles supported response versions without deriving resource identity from secret bytes', async () => {
    const f = fixture({ noResourceId: true });const r = await autoEnrollApprovedLiteLlmCustomer(input, policy, f.management);expect(r.providerResourceId).toBe(policy.keyAlias);expect(r.providerResourceId).not.toContain(r.value);
  });
  it('fails closed on post-issue policy mismatch without issuing a second key', async () => {
    const f = fixture({ existingTeam: true, keyReadbackMismatch: true });await expect(autoEnrollApprovedLiteLlmCustomer(input, policy, f.management)).rejects.toThrow('readback_unknown_no_replay');expect(f.calls.filter(x => x.path === '/key/generate')).toHaveLength(1);
  });
  it('composes with consumed-intent delivery and returns only the Vault receipt', async () => {
    const f = fixture();let used = false, stored = 0;
    const readback = async () => ({ ...input, providerResourceId: policy.keyAlias, stored: true as const });
    const ports: Omit<CentralIssuancePorts, 'issue'> = {
      async consumeAndVerifyReceiver() { if (used) throw new Error('already used');used = true; },
      async deliver(value) { expect(value.value).toBe('synthetic-private-key');stored++;return readback(); }, readback,
    };
    const receipt = await autoEnrollAndDeliverLiteLlmCustomer(input, policy, f.management, ports);expect(JSON.stringify(receipt)).not.toContain('synthetic-private-key');expect(stored).toBe(1);
    await expect(autoEnrollAndDeliverLiteLlmCustomer(input, policy, f.management, ports)).rejects.toThrow('intent_denied');expect(stored).toBe(1);
  });
});

it('later independent provider readback has no issuance side effect and rejects drift',async()=>{
 const f=fixture({noResourceId:true});await autoEnrollApprovedLiteLlmCustomer(input,policy,f.management);f.calls.length=0;
 expect(await readApprovedAutoLiteLlmCustomer(input,policy,f.management)).toEqual({providerResourceId:policy.keyAlias});expect(f.calls.every(c=>c.method==='GET')).toBe(true);
 await expect(readApprovedAutoLiteLlmCustomer(input,{...policy,teamAlias:'different'},f.management)).rejects.toThrow('provider_readback_unverified');
});

it('GPT-only profile requires explicit approval and exact singleton model',async()=>{
 const f=fixture();
 await expect(autoEnrollApprovedLiteLlmCustomer(input,{...policy,models:['gpt-6.1-sol']},f.management)).rejects.toThrow('policy_invalid');
 await expect(autoEnrollApprovedLiteLlmCustomer(input,{...policy,modelPolicy:'gpt-only',models:['gpt-6.1-sol','mini']},f.management)).rejects.toThrow('policy_invalid');
 expect(f.calls).toHaveLength(0);
 const approved={...policy,modelPolicy:'gpt-only' as const,models:['gpt-6.1-sol']};
 const base=f.management.request;
 const management={request:async(path:string,method:'GET'|'POST',body?:object)=>{
  const raw=await base(path,method,body);
  if(path==='/team/new')return {...(raw as object),models:approved.models};
  if(path.startsWith('/team/info?'))return {team_info:{...(raw as any).team_info,models:approved.models}};
  if(path.startsWith('/key/list?')){const x=raw as any;return {...x,keys:x.keys.map((k:any)=>({...k,models:approved.models}))};}
  return raw;
 }};
 expect(await autoEnrollApprovedLiteLlmCustomer(input,approved,management)).toMatchObject({providerResourceId:policy.keyAlias});
});
