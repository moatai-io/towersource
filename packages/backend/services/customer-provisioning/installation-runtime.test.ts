import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({bootstrap:vi.fn(),listen:vi.fn()}));
vi.mock('./owner-bootstrap.js',()=>({bootstrapApprovedCustomerOwner:m.bootstrap}));
vi.mock('./enrollment-listener.js',()=>({startCustomerEnrollmentListener:m.listen}));
import {startApprovedCustomerInstallation} from './installation-runtime.js';
const owner={actorUserId:7,projectId:'fixture',customerId:'fixture',instanceId:'fixture',approvalHash:'a'.repeat(64)};
const input=()=>({ownerAuthority:{load:vi.fn(),assertInstalledIdentity:vi.fn(),assertCurrent:vi.fn()},preflight:vi.fn().mockResolvedValue(undefined),receiverFor:vi.fn().mockResolvedValue({serviceToken:'fixture'}),port:19001});
beforeEach(()=>{vi.clearAllMocks();m.bootstrap.mockResolvedValue({...owner});m.listen.mockResolvedValue({fixture:true});});
it('rejects malformed configuration before any local writes',async()=>{
 await expect(startApprovedCustomerInstallation({...input(),port:80})).rejects.toThrow('port_invalid');
 await expect(startApprovedCustomerInstallation({...input(),ownerAuthority:{} as any})).rejects.toThrow('authority_unconfigured');
 expect(m.bootstrap).not.toHaveBeenCalled();expect(m.listen).not.toHaveBeenCalled();
});
it('preflight failure never creates owner or starts receiver',async()=>{
 const x=input();x.preflight.mockRejectedValue(Error('deployment_not_ready'));
 await expect(startApprovedCustomerInstallation(x)).rejects.toThrow('deployment_not_ready');expect(m.bootstrap).not.toHaveBeenCalled();expect(m.listen).not.toHaveBeenCalled();
});
it('binds receiver to installed owner and starts only after bootstrap',async()=>{
 const events:string[]=[];const x=input();x.preflight.mockImplementation(async()=>{events.push('preflight');});m.bootstrap.mockImplementation(async()=>{events.push('owner');return {...owner};});
 x.receiverFor.mockImplementation(async(actual)=>{events.push('receiver');expect(actual).toEqual(owner);expect(Object.isFrozen(actual)).toBe(true);return {serviceToken:'fixture'};});m.listen.mockImplementation(async()=>{events.push('listen');return {};});
 expect((await startApprovedCustomerInstallation(x)).owner).toEqual(owner);expect(events).toEqual(['preflight','owner','receiver','listen']);
});
it('bootstrap failure prevents receiver construction',async()=>{
 const x=input();m.bootstrap.mockRejectedValue(Error('owner_denied'));await expect(startApprovedCustomerInstallation(x)).rejects.toThrow('owner_denied');expect(x.receiverFor).not.toHaveBeenCalled();expect(m.listen).not.toHaveBeenCalled();
});
it('listener failure is propagated without replaying bootstrap',async()=>{
 const x=input();m.listen.mockRejectedValue(Error('EADDRINUSE'));await expect(startApprovedCustomerInstallation(x)).rejects.toThrow('EADDRINUSE');expect(m.bootstrap).toHaveBeenCalledTimes(1);expect(m.listen).toHaveBeenCalledTimes(1);
});
