import {mkdtemp,mkdir,writeFile,rm,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {fileCentralIssuerAuthority,type PublishedIssuerApproval} from './central-issuer-authority.js';
import {centralRelayContractHash} from './central-relay.js';
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'issuer-fixture-'));dirs.push(root);const approvals=path.join(root,'approvals'),intents=path.join(root,'intents');await mkdir(approvals,{mode:0o700});await mkdir(intents,{mode:0o700});
 const contract={authorityId:'central-fixture',revision:'a'.repeat(40),issuerRuntimeId:'primary-fixture',receiverRuntimeId:'receiver-fixture',customerId:'fixture',instanceId:'22222222-2222-4222-8222-222222222222',approvalHash:'a'.repeat(64),policyHash:'b'.repeat(64),providerKind:'litellm' as const,credentialId:'fixture-key'};
 const input={intentId:'11111111-1111-4111-8111-111111111111',customerId:contract.customerId,instanceId:contract.instanceId,approvalHash:contract.approvalHash,policyHash:contract.policyHash,providerKind:contract.providerKind,credentialId:contract.credentialId};
 const a:PublishedIssuerApproval={contract,policy:{...input,teamId:'fixture',teamAlias:'fixture',keyAlias:'fixture-key',models:['gpt-6.1-sol','~deepseek/deepseek-pro-latest','z-ai/glm-5.3'],monthlyBudgetUsd:50,budgetDuration:'30d'},receiver:{baseUrl:'https://fixture.example/',serviceToken:'fixture-token-'.repeat(4)},intentId:input.intentId,expiresAt:'2030-01-01T00:00:00Z',revoked:false};
 const file=path.join(approvals,contract.approvalHash+'.json');await writeFile(file,JSON.stringify(a),{mode:0o600});
 const authority=fileCentralIssuerAuthority({approvalDirectory:approvals,intentDirectory:intents,attest:vi.fn(),verifyReceiver:vi.fn(),now:()=>Date.parse('2026-01-01T00:00:00Z')});return {authority,input,a,file,intents,approvals};
}
it('loads exact published policy and denies input-selected binding',async()=>{const f=await fixture();expect(await f.authority.contractFor(f.input.approvalHash,'litellm')).toEqual(f.a.contract);await expect(f.authority.approvedDelivery({...f.input,credentialId:'other'})).rejects.toThrow('intent_mismatch');});
it('atomic durable intent allows only one concurrent consumer and never replay',async()=>{const f=await fixture(),h=centralRelayContractHash(f.a.contract);const results=await Promise.allSettled([f.authority.consumeRelayIntent(h,f.input),f.authority.consumeRelayIntent(h,f.input)]);expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);await expect(f.authority.consumeRelayIntent(h,f.input)).rejects.toThrow();});
it('expired or revoked approvals are not authority',async()=>{const f=await fixture();for(const a of [{...f.a,revoked:true},{...f.a,expiresAt:'2020-01-01T00:00:00Z'}]){await writeFile(f.file,JSON.stringify(a));await expect(f.authority.approvedDelivery(f.input)).rejects.toThrow('approval_denied');}});
it('rejects accessible files/directories and symlink authority',async()=>{const f=await fixture();await chmod(f.file,0o644);await expect(f.authority.approvedDelivery(f.input)).rejects.toThrow('file_invalid');await chmod(f.file,0o600);await chmod(f.approvals,0o755);await expect(f.authority.approvedDelivery(f.input)).rejects.toThrow('directory_invalid');await chmod(f.approvals,0o700);await rm(f.file);await symlink('/etc/passwd',f.file);await expect(f.authority.approvedDelivery(f.input)).rejects.toThrow();});
it('Zuplo exact approval is separate from LiteLLM under same hash, with one-shot intent',async()=>{
 const {fileCentralZuploAuthority}=await import('./central-issuer-authority.js');const f=await fixture();const input={...f.input,providerKind:'zuplo' as const,intentId:'33333333-3333-4333-8333-333333333333',credentialId:'gateway'};const contract={...f.a.contract,providerKind:'zuplo' as const,credentialId:'gateway'};
 const approval={...f.a,contract,intentId:input.intentId,policy:{...input,account:'fixture',bucketId:'bckt_fixture',consumerName:'vm-fixture'}};
 await writeFile(path.join(f.approvals,input.approvalHash+'.zuplo.json'),JSON.stringify(approval),{mode:0o600});
 const a=fileCentralZuploAuthority({approvalDirectory:f.approvals,intentDirectory:f.intents,attest:vi.fn(),verifyReceiver:vi.fn(),now:()=>Date.parse('2026-01-01T00:00:00Z')});
 expect((await a.approvedDelivery(input)).policy.consumerName).toBe('vm-fixture');await expect(a.contractFor(input.approvalHash,'litellm')).rejects.toThrow();
 const h=centralRelayContractHash(contract);await a.consumeRelayIntent(h,input);await expect(a.consumeRelayIntent(h,input)).rejects.toThrow();expect((await f.authority.approvedDelivery(f.input)).policy.teamId).toBe('fixture');
});
it('published customer relay reads original intent without consuming central authority',async()=>{
 const {publishedCustomerRelayAuthority}=await import('./published-customer-relay-authority.js');const f=await fixture();
 // fixture approval expiration must be current for the deployment accessor.
 const a={...f.a,expiresAt:new Date(Date.now()+60000).toISOString()};await writeFile(f.file,JSON.stringify(a),{mode:0o600});
 const reader=publishedCustomerRelayAuthority({approvalDirectory:f.approvals,intentDirectory:f.intents,endpoint:'https://central.example/internal',serviceToken:'fixture-token-'.repeat(4),readback:vi.fn()});
 const b={customerId:f.input.customerId,instanceId:f.input.instanceId,projectId:'33333333-3333-4333-8333-333333333333',actorUserId:1};
 const request={customerId:b.customerId,instanceId:b.instanceId,approvalHash:f.input.approvalHash,providerKind:'litellm' as const,operation:'enrollment-readback' as const};
 const result=await reader.approved(request,b);expect(result.delivery.intentId).toBe(f.input.intentId);expect(result.transport.contractHash).toBe(centralRelayContractHash(f.a.contract));
 await expect(reader.approved({...request,operation:'enrollment-issue',intentId:'44444444-4444-4444-8444-444444444444'},b)).rejects.toThrow('intent_mismatch');
 // Readback configuration did not consume: original central one-shot call is still available.
 await f.authority.consumeRelayIntent(centralRelayContractHash(f.a.contract),f.input);
});
