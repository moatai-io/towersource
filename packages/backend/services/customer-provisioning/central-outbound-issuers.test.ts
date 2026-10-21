import {it,expect,vi} from 'vitest';
import {centralOutboundIssuers} from './central-outbound-issuers.js';
it('composes existing Zuplo HTTP client and issuer with one creation and fixed origin',async()=>{
 const fetcher=vi.spyOn(globalThis,'fetch');
 const approved={intentId:'11111111-1111-4111-8111-111111111111',customerId:'fixture',instanceId:'22222222-2222-4222-8222-222222222222',approvalHash:'a'.repeat(64),policyHash:'b'.repeat(64),providerKind:'zuplo' as const,credentialId:'gateway'};
 const policy={...approved,account:'fixture-account',bucketId:'fixture-bucket',consumerName:'fixture-consumer'};
 try{fetcher.mockResolvedValueOnce(Response.json({offset:0,limit:100,data:[]})).mockResolvedValueOnce(Response.json({id:'fixture-id',name:policy.consumerName,apiKeys:[{key:'synthetic-key'}]}));
 const issuer=centralOutboundIssuers({litellm:{baseUrl:'http://127.0.0.1:4000',masterKey:'x'.repeat(40)},zuplo:'synthetic-zuplo-token'});
 expect(await issuer.issueZuplo(approved,policy)).toEqual({providerResourceId:'fixture-id',value:'synthetic-key'});
 expect(fetcher).toHaveBeenCalledTimes(2);expect(String(fetcher.mock.calls[1][0])).toMatch(/^https:\/\/dev\.zuplo\.com\//);expect(fetcher.mock.calls[1][1]?.method).toBe('POST');
 const body=JSON.parse(String(fetcher.mock.calls[1][1]?.body));expect(body.metadata.delivery_intent_id).toBe(approved.intentId);
 }finally{fetcher.mockRestore();}
});
it('rejects remote LiteLLM management endpoint before making requests',()=>{expect(()=>centralOutboundIssuers({litellm:{baseUrl:'https://remote.fixture',masterKey:'x'.repeat(40)},zuplo:'synthetic-zuplo-token'})).toThrow('config_invalid');});

it('Zuplo readback uses actual metadata and denies mismatched execution',async()=>{
 const input={intentId:'intent',customerId:'fixture',instanceId:'instance',approvalHash:'a'.repeat(64),policyHash:'b'.repeat(64),providerKind:'zuplo' as const,credentialId:'gateway'};
 const policy={...input,account:'account',bucketId:'bucket',consumerName:'consumer'};
 const mock=vi.spyOn(globalThis,'fetch');
 try{mock.mockResolvedValueOnce(Response.json({offset:0,limit:100,data:[{id:'actual',name:'consumer',metadata:{customer_id:'fixture',instance_id:'instance',approval_hash:input.approvalHash,policy_hash:input.policyHash,delivery_intent_id:'intent'}}]}));
 const client=centralOutboundIssuers({litellm:{baseUrl:'http://127.0.0.1:4000',masterKey:'x'.repeat(40)},zuplo:'synthetic-zuplo-token'});
 expect(await client.readZuplo(input,policy)).toEqual({providerResourceId:'actual'});
 mock.mockResolvedValueOnce(Response.json({offset:0,limit:100,data:[{id:'actual',name:'consumer',metadata:{}}]}));await expect(client.readZuplo(input,policy)).rejects.toThrow('unverified');
 }finally{mock.mockRestore();}
});
it('permits only an explicitly installed single-label Docker origin',()=>{
 const base={masterKey:'x'.repeat(40)};
 expect(()=>centralOutboundIssuers({litellm:{...base,baseUrl:'http://litellm:4000',installedDockerOrigin:'http://litellm:4000'},zuplo:'synthetic-zuplo-token'})).not.toThrow();
 for(const value of [{baseUrl:'http://litellm:4000'},{baseUrl:'http://other:4000',installedDockerOrigin:'http://litellm:4000'},{baseUrl:'http://example.com:4000',installedDockerOrigin:'http://example.com:4000'}])expect(()=>centralOutboundIssuers({litellm:{...base,...value},zuplo:'synthetic-zuplo-token'})).toThrow('config_invalid');
});
