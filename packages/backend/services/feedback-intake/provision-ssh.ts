import path from 'node:path';
import { z } from 'zod';
import { readPrivate, refuse } from './provision-files.js';
import { type CustomerTransport } from './provision-customer.js';
import { type CommandRunner, subprocessRunner, safePath, hashSchema, responseSchema, productionChecks, type LocalChecks } from './provision-runtime.js';

export const sshConfigSchema=z.object({target:z.string().regex(/^[a-z_][a-z0-9_-]*@[a-z0-9][a-z0-9.-]*$/),
  knownHosts:safePath,identityFile:safePath,node:safePath,receiver:safePath,bindingPath:safePath,bindingHash:hashSchema,
}).strict();
export type SshConfig=z.infer<typeof sshConfigSchema>;
export function sshReceiverArgv(raw: SshConfig): string[]{
  const s=sshConfigSchema.parse(raw);
  // Every remote argument is a strictly constrained absolute path, no shell metacharacters.
  return ['-F','/dev/null','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes',
    '-o','IdentityAgent=none','-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no',
    '-o',`UserKnownHostsFile=${s.knownHosts}`,'-o','GlobalKnownHostsFile=/dev/null','-i',s.identityFile,
    '--',s.target,'/usr/bin/env','-i','PATH=/usr/bin:/bin','LANG=C.UTF-8',s.node,s.receiver,'--binding',s.bindingPath];
}
export function sshCustomerTransport(raw:SshConfig,runner:CommandRunner=subprocessRunner,checks:LocalChecks=productionChecks):CustomerTransport{
  const s=sshConfigSchema.parse(raw);const argv=sshReceiverArgv(s);
  const call=async(request:object)=>{
    for(const file of [s.knownHosts,s.identityFile]){checks.ancestors(path.dirname(file));if(readPrivate(file).length===0)refuse();}
    const input=Buffer.from(JSON.stringify(request));
    try{
      const output=await runner('/usr/bin/ssh',argv,input);
      if(output.length>8192)refuse();
      const response=responseSchema.parse(JSON.parse(output.toString()));if(response.bindingHash!==s.bindingHash)refuse();return response;
    }catch{return refuse();}finally{input.fill(0);}
  };
  return {async inspect(token){const r=await call({action:'inspect',bindingHash:s.bindingHash,...(token?{token}:{})});if(r.status!=='inspected')return refuse();return r.snapshot;},
    async appendStdin(input){const {version,...r}=JSON.parse(input.toString());if(version!==1)refuse();const result=await call({action:'append',bindingHash:s.bindingHash,...r});if(result.status!=='appended')refuse();}};
}
