import {expect,it} from 'vitest';
import {workstationSystemdRunSpec} from './workstation-systemd-run-spec.js';
const input={runId:'12345678-1234-1234-1234-123456789abc',mapping:{projectId:'p',projectRoot:'/project',home:'/home/p',controllerUid:1,launcherUid:2,commandUid:3,commandGid:3},timeoutSec:5,runDirectory:'/run/tower/demo',environmentFile:'/run/tower/demo/env',commandFile:'/run/tower/demo/command'};
it('uses fixed nonroot account and cgroup ownership without delegation',()=>{
 const r=workstationSystemdRunSpec(input);
 expect(r.args).toContain('--property=KillMode=control-group');expect(r.args).toContain('--property=Delegate=no');expect(r.args).toContain('--property=User=3');
 expect(r.args).toContain('--property=StandardOutput=null');expect(r.args).not.toContain('--scope');
});
it('rejects untrusted run paths and root',()=>{
 expect(()=>workstationSystemdRunSpec({...input,commandFile:'/elsewhere'})).toThrow('PATH_INVALID');
 expect(()=>workstationSystemdRunSpec({...input,mapping:{...input.mapping,commandUid:0}})).toThrow('IDENTITY_INVALID');
});
it('quotes HOME without limiting ordinary project artifact file sizes',()=>{
 const result=workstationSystemdRunSpec({...input,mapping:{...input.mapping,home:'/home/project space'}});
 expect(result.args).toContain('--property=Environment="HOME=/home/project space"');
 expect(result.args.some(arg=>/LimitFSIZE|ulimit|prlimit/.test(arg))).toBe(false);
 expect(result.args).toContain('--property=MemoryMax=256M');
});
