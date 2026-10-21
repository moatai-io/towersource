import {it,expect,vi} from 'vitest';
vi.mock('node:child_process',()=>({execFileSync:vi.fn()}));
import {execFileSync} from 'node:child_process';
import {systemdAcl} from './outbound-startup-config.js';
it('only exact service ACL is accepted in systemd credential paths',()=>{
 const f=vi.mocked(execFileSync);f.mockReturnValue('user::r--\nuser:984:r--\ngroup::---\nmask::r--\nother::---\n');
 expect(systemdAcl('/run/credentials/tower-provisioning.service/outbound-machine',984,false)).toBe(true);
 expect(systemdAcl('/etc/credentials/outbound-machine',984,false)).toBe(false);
 expect(systemdAcl('/run/credentials/tower-provisioning.service/outbound-machine',985,false)).toBe(false);
 f.mockReturnValue('user::r--\nuser:984:r--\nuser:985:r--\ngroup::---\nmask::r--\nother::---\n');expect(systemdAcl('/run/credentials/tower-provisioning.service/outbound-machine',984,false)).toBe(false);
 f.mockImplementation(()=>{throw Error('missing');});expect(systemdAcl('/run/credentials/tower-provisioning.service/outbound-machine',984,false)).toBe(false);
});
