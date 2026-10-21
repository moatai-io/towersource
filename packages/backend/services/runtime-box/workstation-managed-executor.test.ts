import {expect,it,vi} from 'vitest';
import {createManagedWorkstationExecutor} from './workstation-managed-executor.js';
function fixture(){
 const manager={probe:vi.fn().mockResolvedValue({identityVerified:true,cgroupOwnership:true}),start:vi.fn().mockResolvedValue({completed:Promise.resolve({exitCode:0,stdout:'hello token-value',stderr:''})}),stopAndVerify:vi.fn().mockResolvedValue({empty:true})};
 const cleanup=vi.fn().mockResolvedValue(undefined);
 const prepare=vi.fn().mockResolvedValue({env:{TOKEN:'token-value'},redaction:{exhaustive:true,values:['token-value']},cleanup});
 const cap=createManagedWorkstationExecutor({mapping:{projectId:'p',projectRoot:'/project',home:'/home/project',controllerUid:1,launcherUid:2,commandUid:3,commandGid:3},manager,prepare,operationDeadlineMs:100});
 const request={command:'python work/arbitrary.py --report',timeoutSec:2,credentials:{TOKEN:'token-value'},signal:new AbortController().signal};
 return{manager,cleanup,prepare,cap,request};
}
it('runs general command via installed manager, verifies empty before cleanup, redacts selected secrets',async()=>{
 const f=fixture();const r=await f.cap.execute(f.request);
 expect(r.stdout).toBe('hello [REDACTED]');expect(f.manager.start).toHaveBeenCalledWith(expect.objectContaining({command:f.request.command,mapping:expect.objectContaining({commandUid:3})}));
 expect(f.manager.stopAndVerify.mock.invocationCallOrder[0]).toBeLessThan(f.cleanup.mock.invocationCallOrder[0]);
});
it('refuses unavailable live cgroup capability before credentials',async()=>{
 const f=fixture();f.manager.probe.mockResolvedValue({identityVerified:true,cgroupOwnership:false});
 await expect(f.cap.execute(f.request)).rejects.toThrow('CAPABILITY_UNAVAILABLE');expect(f.prepare).not.toHaveBeenCalled();
});
it('retains credentials when descendants cannot be verified stopped',async()=>{
 const f=fixture();f.manager.stopAndVerify.mockResolvedValue({empty:false});
 await expect(f.cap.execute(f.request)).rejects.toThrow('CREDENTIALS_RETAINED');expect(f.cleanup).not.toHaveBeenCalled();
});
it('recovers partial start failure before cleaning files',async()=>{
 const f=fixture();f.manager.start.mockRejectedValue(new Error('partial start'));
 await expect(f.cap.execute(f.request)).rejects.toThrow('EXECUTION_FAILED');expect(f.manager.stopAndVerify).toHaveBeenCalledOnce();expect(f.cleanup).toHaveBeenCalledOnce();
});
it('cancels a start-in-flight using run ownership tombstone contract',async()=>{
 const f=fixture();const abort=new AbortController();
 f.manager.start.mockImplementation(async()=>{abort.abort();return new Promise(()=>{});});
 await expect(f.cap.execute({...f.request,signal:abort.signal})).rejects.toThrow('CANCELLED');expect(f.cleanup).toHaveBeenCalledOnce();
});
it('does not claim cleanup after a stop timeout',async()=>{
 const f=fixture();f.manager.stopAndVerify.mockImplementation(()=>new Promise(()=>{}));
 await expect(f.cap.execute(f.request)).rejects.toThrow('TERMINATION_UNVERIFIED');expect(f.cleanup).not.toHaveBeenCalled();
});
it('reports cleanup failure',async()=>{
 const f=fixture();f.cleanup.mockRejectedValue(new Error('private path'));
 await expect(f.cap.execute(f.request)).rejects.toThrow(/^EXECUTOR_CLEANUP_INCOMPLETE$/);
});
