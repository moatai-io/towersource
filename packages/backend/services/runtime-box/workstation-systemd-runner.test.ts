import {expect,it,vi} from 'vitest';
import {createLocalSystemdRunner} from './workstation-systemd-runner.js';
const unit='tower-command-12345678-1234-1234-1234-123456789abc.service';
const invocationId='a'.repeat(32),cgroup='/system.slice/'+unit;
const evidence={invocationId,cgroup,terminal:true};
function fixture(fields:string,events='populated 0\n'){
 const run=vi.fn().mockResolvedValue({code:0,stdout:fields});const readEvents=vi.fn().mockResolvedValue(events);
 return{run,readEvents,runner:createLocalSystemdRunner(async()=>({identityVerified:false,cgroupOwnership:false}),{run,readEvents})};
}
it('accepts the observed empty service cgroup',async()=>{const f=fixture(`LoadState=loaded\nActiveState=inactive\nInvocationID=${invocationId}\nControlGroup=${cgroup}`);expect(await f.runner.cgroupEmpty(unit,evidence)).toBe(true);});
it.each(['not-found','error'])('never trusts %s unit disappearance',async load=>{const f=fixture(`LoadState=${load}\nActiveState=inactive\nInvocationID=${invocationId}`);expect(await f.runner.cgroupEmpty(unit,evidence)).toBe(false);expect(f.readEvents).not.toHaveBeenCalled();});
it('requires matching persisted terminal identity for removed cgroup',async()=>{const f=fixture(`LoadState=loaded\nActiveState=inactive\nInvocationID=${invocationId}\nControlGroup=`);f.readEvents.mockRejectedValue(Object.assign(new Error(),{code:'ENOENT'}));expect(await f.runner.cgroupEmpty(unit,evidence)).toBe(true);expect(await f.runner.cgroupEmpty(unit,{...evidence,terminal:false})).toBe(false);});
it('rejects another invocation or populated group',async()=>{const f=fixture(`LoadState=loaded\nActiveState=inactive\nInvocationID=${'b'.repeat(32)}\nControlGroup=${cgroup}`);expect(await f.runner.cgroupEmpty(unit,evidence)).toBe(false);const g=fixture(`LoadState=loaded\nActiveState=inactive\nInvocationID=${invocationId}\nControlGroup=${cgroup}`,'populated 1');expect(await g.runner.cgroupEmpty(unit,evidence)).toBe(false);});
it('fails closed on permission and I/O failures',async()=>{const f=fixture(`LoadState=loaded\nActiveState=inactive\nInvocationID=${invocationId}\nControlGroup=${cgroup}`);f.readEvents.mockRejectedValue(Object.assign(new Error(),{code:'EACCES'}));expect(await f.runner.cgroupEmpty(unit,evidence)).toBe(false);f.run.mockResolvedValue({code:1,stdout:''});expect(await f.runner.cgroupEmpty(unit,evidence)).toBe(false);});
it('does not call installation verifier when NSS identity is unavailable',async()=>{const verify=vi.fn().mockResolvedValue({identityVerified:true,cgroupOwnership:true});const runner=createLocalSystemdRunner(verify);const result=await runner.probe({projectId:'test',projectRoot:'/project',home:'/home/test',controllerUid:1,launcherUid:2,commandUid:4294967295,commandGid:4294967295});expect(result.identityVerified).toBe(false);expect(verify).not.toHaveBeenCalled();});
