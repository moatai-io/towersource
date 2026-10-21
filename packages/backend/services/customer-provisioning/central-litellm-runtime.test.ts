import {afterEach,expect,it,vi} from 'vitest';
import {centralLiteLlmRuntime} from './central-litellm-runtime.js';
import type {ApprovedDelivery} from './central-delivery.js';
const input:ApprovedDelivery={intentId:'11111111-1111-4111-8111-111111111111',customerId:'fixture',instanceId:'22222222-2222-4222-8222-222222222222',approvalHash:'a'.repeat(64),policyHash:'b'.repeat(64),providerKind:'litellm',credentialId:'fixture-key'};
const token='fixture-token-'.repeat(4);
afterEach(()=>vi.unstubAllGlobals());
function fixture(){
 const policy={...input,teamId:'fixture-team',teamAlias:'fixture-team',keyAlias:'fixture-key',models:['gpt-6.1-sol','~deepseek/deepseek-pro-latest','z-ai/glm-5.3'],monthlyBudgetUsd:50 as const,budgetDuration:'30d' as const};
 const authority={contractFor:vi.fn(),authorizeContract:vi.fn(),attest:vi.fn(),consumeRelayIntent:vi.fn(),approvedDelivery:vi.fn(async()=>({policy,receiver:{baseUrl:'https://fixture.example/',serviceToken:token}})),verifyReceiver:vi.fn()};
 let team:object|undefined,key:object|undefined;
 const management={request:vi.fn(async(path:string,_method:string,body?:object)=>{
  if(path==='/models')return {data:policy.models.map(id=>({id}))};
  if(path==='/team/list')return {teams:[],total:0};
  if(path.startsWith('/team/info'))return {team_info:team};
  if(path.startsWith('/key/list'))return {keys:key?[key]:[],total_count:key?1:0};
  if(path==='/team/new'){team=body;return body;}
  if(path==='/key/generate'){key=body;return {...body,key:'fixture-issued-key'};}
  throw Error('unexpected');
 })};return {authority,management};
}
it('attests approved receiver before any provider mutation',async()=>{
 const f=fixture();f.authority.verifyReceiver.mockRejectedValue(Error('denied'));
 const r=centralLiteLlmRuntime({serviceToken:token,...f});
 await expect(r.ports.issueAndDeliver({} as any,input)).rejects.toThrow('denied');expect(f.management.request).not.toHaveBeenCalled();
});
it('concrete management to delivery to independent readback exposes only receipt',async()=>{
 const f=fixture(),bodies:any[]=[];vi.stubGlobal('fetch',vi.fn(async(u:any,o:any)=>{bodies.push(JSON.parse(o.body));return Response.json(String(u).endsWith('/preflight')?{...input,ready:true}:{...input,providerResourceId:'fixture-key',stored:true});}));
 const r=centralLiteLlmRuntime({serviceToken:token,...f});const result=await r.ports.issueAndDeliver({} as any,input);
 expect(result).toEqual({...input,providerResourceId:'fixture-key',stored:true});expect(bodies).toHaveLength(3);expect(bodies[0]).not.toHaveProperty('value');expect(bodies[1].value).toBe('fixture-issued-key');expect(bodies[2]).not.toHaveProperty('value');
 expect(f.authority.verifyReceiver).toHaveBeenCalledOnce();
});
it('does not issue when approved receiver transport configuration is invalid',async()=>{
 const f=fixture();f.authority.approvedDelivery.mockResolvedValue({...await f.authority.approvedDelivery(),receiver:{baseUrl:'http://untrusted.example/',serviceToken:token}});
 const r=centralLiteLlmRuntime({serviceToken:token,...f});await expect(r.ports.issueAndDeliver({} as any,input)).rejects.toThrow('config_invalid');expect(f.management.request).not.toHaveBeenCalled();
});
