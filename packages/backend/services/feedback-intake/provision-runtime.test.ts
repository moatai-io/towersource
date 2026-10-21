import { describe,it,expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { subprocessRunner, requestSchema, verifySelfLocation } from './provision-runtime.js';
import { sshReceiverArgv, sshConfigSchema } from './provision-ssh.js';
import { launcherConfigSchema } from './provision-launcher.js';
describe('production provisioning executable boundary',()=>{
  it('subprocess inherits no provider, pg, node-options or ssh-agent variables',async()=>{
    const out=await subprocessRunner(process.execPath,['-e','process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))'],Buffer.alloc(0));
    const names=JSON.parse(out.toString());expect(names).toEqual(['LANG','PATH']);
  });
  it('bounds response output and discards secret stderr and nonzero stdout',async()=>{
    await expect(subprocessRunner(process.execPath,['-e','process.stderr.write("synthetic-private-error");process.stdout.write("synthetic-private-output");process.exit(1)'],Buffer.alloc(0))).rejects.toThrow('feedback_provision_transport_failed');
    await expect(subprocessRunner(process.execPath,['-e','process.stdout.write("x".repeat(9000))'],Buffer.alloc(0))).rejects.toThrow('feedback_provision_transport_failed');
  });
  it('pins SSH config/host-key/identity and clears remote environment',()=>{
    const s={target:'backend@customer.example.com',knownHosts:'/etc/tower/known_hosts',identityFile:'/etc/tower/identity',node:'/nix/store/node/bin/node',receiver:'/nix/store/app/lib/tower/dist/backend/packages/backend/services/feedback-intake/provision-receiver-cli.js',bindingPath:'/etc/tower/feedback.json',bindingHash:'a'.repeat(64)};
    const args=sshReceiverArgv(s);expect(args.slice(0,2)).toEqual(['-F','/dev/null']);
    expect(args).toContain('IdentityAgent=none');expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args).toContain('/usr/bin/env');expect(args).toContain('-i');
    expect(()=>sshConfigSchema.parse({...s,receiver:'/tmp/file;touch'})).toThrow();
    expect(()=>sshConfigSchema.parse({...s,identityFile:'/etc/tower/../identity'})).toThrow();
  });
  it('rejects request unknown fields and wrong CLI invocation with fixed responses',()=>{
    expect(()=>requestSchema.parse({action:'inspect',bindingHash:'a'.repeat(64),envPath:'/unapproved'})).toThrow();
    for(const entry of ['provision-launcher-cli.ts','provision-receiver-cli.ts']){
      const r=spawnSync(process.execPath,['--import','tsx',`packages/backend/services/feedback-intake/${entry}`,'--force'],{encoding:'utf8'});
      expect(r.status).toBe(1);expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/^feedback_provision_(launcher|receiver)_refused\n$/);
    }
  });
  it('refuses a CLI from outside the approved immutable closure',()=>{
    expect(()=>verifySelfLocation('/nix/store/example/share/tower/release-manifest.json',import.meta.url)).toThrow();
  });
});
