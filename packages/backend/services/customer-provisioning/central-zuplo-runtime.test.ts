import {it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({preflight:vi.fn(),deliver:vi.fn(),readback:vi.fn()}));vi.mock('./central-http-delivery.js',()=>({customerDeliveryTransport:()=>m}));
import {centralZuploRuntime} from './central-zuplo-runtime.js';
const input={intentId:'11111111-1111-4111-8111-111111111111',customerId:'fixture',instanceId:'22222222-2222-4222-8222-222222222222',approvalHash:'a'.repeat(64),policyHash:'b'.repeat(64),providerKind:'zuplo' as const,credentialId:'gateway'};
it('preflight precedes create and only receipt crosses relay boundary',async()=>{const events:string[]=[];const receipt={...input,providerResourceId:'csmr_fixture',stored:true};m.preflight.mockImplementation(async()=>{events.push('preflight');});m.deliver.mockImplementation(async x=>{events.push('deliver');expect(x.value).toBe('synthetic-secret');return receipt;});m.readback.mockResolvedValue(receipt);
 const a:any={contractFor:vi.fn(),authorizeContract:vi.fn(),attest:vi.fn(),consumeRelayIntent:vi.fn(),approvedDelivery:async()=>({policy:{...input,account:'fixture',bucketId:'bckt_fixture',consumerName:'vm-fixture'},receiver:{}}),verifyReceiver:async()=>{events.push('verify');}};
 const r=centralZuploRuntime({serviceToken:'fixture-'.repeat(8),authority:a,management:{async consumerExists(){events.push('observe');return false;},async createConsumer(){events.push('create');return {id:'csmr_fixture',name:'vm-fixture',apiKeys:[{key:'synthetic-secret'}]};}}});
 const actual=await r.ports.issueAndDeliver({} as any,input);expect(actual).toEqual(receipt);expect(JSON.stringify(actual)).not.toContain('synthetic-secret');expect(events).toEqual(['verify','preflight','observe','create','deliver']);
});
