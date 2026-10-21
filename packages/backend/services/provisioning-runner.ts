import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,isAbsolute} from 'node:path';
import {handleProvisioningCommand,parseProvisioningCommand} from './provisioning-command.js';
import {localProvisioningAuthority,type LocalApprovalEnvelope} from './provisioning-local-authority.js';
import {provisioningHost,type ProvisioningHostConfig} from './provisioning-host.js';
export interface ProvisioningRunnerConfig {version:1;instanceId:string;subject:string;approvalPublicKey:string;host:ProvisioningHostConfig;}
async function trustedConfig(filename:string):Promise<ProvisioningRunnerConfig>{
 if(!isAbsolute(filename)||await realpath(filename)!==filename)throw Error('provisioning_runner_config_invalid');
 const f=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=await f.stat();if(!st.isFile()||st.uid!==0||(st.mode&0o077)!==0||st.size>16384)throw Error('provisioning_runner_config_invalid');const d=JSON.parse((await f.readFile()).toString('utf8')) as ProvisioningRunnerConfig;
  if(d.version!==1||!/^[a-f0-9-]{36}$/.test(d.instanceId)||!/^[A-Za-z0-9_-]{1,120}$/.test(d.subject)||typeof d.approvalPublicKey!=='string'||!d.host)throw Error('provisioning_runner_config_invalid');return d;
 }finally{await f.close();}
}
/** Host transport authenticates SSH/local operator. Signed envelope grants exact commands, never free-form shell. */
export async function runLocalProvisioningCommand(c:ProvisioningRunnerConfig,input:unknown):Promise<unknown>{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==2||!Object.hasOwn(input,'command')||!Object.hasOwn(input,'approval'))throw Error('provisioning_runner_input_invalid');
 const d=input as {command:unknown;approval:LocalApprovalEnvelope};
 if(!d.approval||typeof d.approval!=='object'||Array.isArray(d.approval)||Object.keys(d.approval).length!==2||typeof d.approval.payload!=='string'||typeof d.approval.signature!=='string')throw Error('provisioning_runner_approval_invalid');
 const command=parseProvisioningCommand(d.command);
 if(c.instanceId!==command.instanceId)throw Error('provisioning_runner_instance_mismatch');
 const authority=await localProvisioningAuthority({directory:c.host.directory,publicKey:c.approvalPublicKey,approval:d.approval});
 // Creating/checking host paths is deferred until the authenticated lock is held.
 const lazy=async()=>provisioningHost(c.host);
 return handleProvisioningCommand(command,{subject:c.subject,instanceId:c.instanceId},authority,{verify:async r=>(await lazy()).verify(r),start:async (cmd,f)=>(await lazy()).start(cmd,f),stopExact:async (cmd,f)=>(await lazy()).stopExact(cmd,f),adopt:async (cmd,f)=>(await lazy()).adopt(cmd,f),observe:async cmd=>(await lazy()).observe(cmd)});
}
async function main(){
 try{
  if(process.getuid?.()!==0||process.argv.length!==2)throw Error('provisioning_runner_requires_root');
  const c=await trustedConfig('/etc/tower-provisioning/runner.json');
  const chunks:Buffer[]=[];let size=0;for await(const chunk of process.stdin){const b=Buffer.from(chunk);size+=b.length;if(size>32768)throw Error('provisioning_runner_input_large');chunks.push(b);}
  const result=await runLocalProvisioningCommand(c,JSON.parse(Buffer.concat(chunks).toString('utf8')));
  process.stdout.write(JSON.stringify(result)+'\n');
 }catch{process.stderr.write('provisioning runner rejected; reconcile before replay\n');process.exitCode=1;}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url)))await main();
