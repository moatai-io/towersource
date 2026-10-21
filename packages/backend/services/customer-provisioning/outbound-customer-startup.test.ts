vi.mock('./outbound-bootstrap-client.js',()=>({redeemOutboundBootstrap:(...args:any[])=>s.bootstrap(...args)}));
import {beforeEach,it,expect,vi} from 'vitest';
const s=vi.hoisted(()=>({loaded:undefined as any,groups:{} as any,bootstrap:vi.fn(),delivery:vi.fn(),runner:vi.fn(),factory:vi.fn(),durable:{assertCurrent:vi.fn(),readResult:vi.fn(),ensureDurableSmoke:vi.fn()},query:vi.fn()}));
vi.mock('./outbound-startup-config.js',()=>({loadOutboundStartupConfig:()=>s.loaded}));
vi.mock('./customer-delivery-route.js',()=>({createInstalledCustomerDelivery:(...args:any[])=>{s.factory(...args);return s.groups[args[0]];}}));
vi.mock('../../db/pg.js',()=>({getPgPool:()=>({})}));vi.mock('../../db/pg-repo.js',()=>({queryOne:(...args:any[])=>s.query(...args)}));
vi.mock('./outbound-local-approval.js',()=>({outboundLocalApproval:()=>vi.fn()}));
vi.mock('./outbound-vault-ports.js',()=>({outboundVaultPorts:()=>({authorize:vi.fn(),readStored:vi.fn(),storeAndVerify:vi.fn()})}));
vi.mock('./outbound-enrollment-client.js',()=>({outboundEnrollmentClient:()=>({tick:(...args:any[])=>s.delivery(...args)})}));
vi.mock('./outbound-durable-smoke.js',()=>({outboundDurableSmoke:()=>s.durable}));
vi.mock('./outbound-ai-report-client.js',()=>({outboundAiReportClient:()=>({tick:vi.fn()})}));
vi.mock('./outbound-customer-runner.js',()=>({runOutboundCustomer:(input:any)=>s.runner(input)}));
import {startOutboundCustomerStartup} from './outbound-customer-startup.js';
beforeEach(()=>{vi.clearAllMocks();s.loaded=undefined;s.groups={};s.bootstrap.mockResolvedValue({registered:true});s.delivery.mockResolvedValue({status:'idle'});s.runner.mockResolvedValue({status:'reported'});s.query.mockResolvedValue({id:'present'});});
function setup(){const deliveries=['zuplo','litellm'].map(provider=>({provider,intentId:provider,policyHash:provider,credentialId:provider}));
 s.loaded={credential:'a'.repeat(43),assertCurrent:vi.fn(),config:{baseUrl:'https://cp.fixture',customerId:'customer',aiIntentId:'ai',deliveryPolicyFiles:{zuplo:'zuplo',litellm:'litellm'},installed:{instanceId:'vm',organizationId:'org',executionId:'run',approvalHash:'hash',deliveries}}};
 for(const d of deliveries)s.groups[d.provider]={approved:{...d,providerKind:d.provider,customerId:'customer',instanceId:'vm',approvalHash:'hash'},assertInstalled:vi.fn(),authority:{readRuntimeBinding:vi.fn(async()=>({})),authorize:vi.fn()},receiver:{readback:vi.fn(async()=>({stored:true}))},createSmokePorts:vi.fn(()=>({}))};
}
it('does nothing without opt-in and rejects missing PostgreSQL before receiver creation',async()=>{expect(await startOutboundCustomerStartup({},false)).toBeUndefined();setup();await expect(startOutboundCustomerStartup({},false)).rejects.toThrow('database_missing');expect(s.factory).not.toHaveBeenCalled();});
it('rejects mismatched provider policy before runner',async()=>{setup();s.groups.litellm.approved.policyHash='other';await expect(startOutboundCustomerStartup({},true)).rejects.toThrow('policy_mismatch');expect(s.runner).not.toHaveBeenCalled();});
it('composes outbound-only receivers, checks persisted credentials and awaits cancellation',async()=>{setup();const handle=await startOutboundCustomerStartup({TOWER_INSTANCE_ID:'vm'},true);expect(s.factory.mock.calls.every(x=>x[3]==='outbound')).toBe(true);await handle!.done;const input=s.runner.mock.calls[0][0];expect(await input.credentialsReady()).toBe(true);s.query.mockResolvedValueOnce(null);expect(await input.credentialsReady()).toBe(false);await expect(handle!.done).resolves.toEqual({status:'reported'});await handle!.close();expect(input.signal.aborted).toBe(true);});
it('turns runner failure into stopped, never reported',async()=>{setup();s.runner.mockRejectedValueOnce(Error('unknown'));const handle=await startOutboundCustomerStartup({},true);expect(await handle!.done).toEqual({status:'stopped'});});

it('redeems bootstrap only for unregistered/denied machine, not ordinary restart or transport failure',async()=>{
 setup();let h=await startOutboundCustomerStartup({},true);await h!.done;expect(s.bootstrap).not.toHaveBeenCalled();
 s.delivery.mockRejectedValueOnce(Error('outbound_delivery_auth_denied'));h=await startOutboundCustomerStartup({},true);expect(await h!.done).toEqual({status:'reported'});expect(s.bootstrap).toHaveBeenCalledTimes(1);
 s.delivery.mockRejectedValueOnce(Error('outbound_delivery_request_failed'));h=await startOutboundCustomerStartup({},true);expect(await h!.done).toEqual({status:'stopped'});expect(s.bootstrap).toHaveBeenCalledTimes(1);
});
