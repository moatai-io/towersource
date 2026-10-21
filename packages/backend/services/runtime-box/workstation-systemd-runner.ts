/** Local fixed-binary runner. Installation must independently authorize systemd
 * operations. No sudo fallback. Does not establish service-manager ACL by itself.
 */
import {startSystemdPipe} from './workstation-systemd-pipe.js';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import type {SystemdRunner} from './workstation-systemd-manager.js';
export function createLocalSystemdRunner(verifyInstallation:SystemdRunner['probe'], testing?: { run: SystemdRunner['run']; readEvents: (path: string) => Promise<string> }):SystemdRunner {
 const run:SystemdRunner['run']=(binary,args)=>new Promise(resolve=>{
  if(!['/usr/bin/systemd-run','/usr/bin/systemctl'].includes(binary)){resolve({code:1,stdout:''});return;}
  execFile(binary,args,{env:{PATH:'/usr/bin:/bin',LANG:'C'},timeout:8000,maxBuffer:8192},(error,stdout)=>resolve({code:error?1:0,stdout}));
 });
 const invoke = testing?.run ?? run;
 const probe:SystemdRunner['probe']=async mapping=>{
  const lookup=(database:string,id:number)=>new Promise<boolean>(resolve=>execFile('/usr/bin/getent',[database,String(id)],{env:{PATH:'/usr/bin:/bin',LANG:'C'},timeout:2000,maxBuffer:4096},(error,stdout)=>{const fields=stdout.trim().split(':');resolve(!error&&fields.length>2&&fields[2]===String(id));}));
  if(!await lookup('passwd',mapping.commandUid)||!await lookup('group',mapping.commandGid))return{identityVerified:false,cgroupOwnership:false};
  // NSS existence is necessary, not sufficient: installation still verifies ACL/groups.
  return verifyInstallation(mapping);
 };
 return {pipe:startSystemdPipe,run:invoke,probe,async cgroupEmpty(unit,evidence){
  if(!/^tower-command-[a-f0-9-]{36}\.service$/.test(unit))return false;
  const info=await invoke('/usr/bin/systemctl',['show',unit,'--property=LoadState,ControlGroup,ActiveState,InvocationID','--no-pager']);
  if(info.code!==0)return false;
  const fields=Object.fromEntries(info.stdout.trim().split('\n').map(x=>x.split('=')));
  // Not-found alone does not prove no late start or escaped/delegated cgroup.
  if(fields.LoadState!=='loaded'||!['inactive','failed'].includes(fields.ActiveState))return false;
  if(evidence && fields.InvocationID!==evidence.invocationId)return false;
  const group=fields.ControlGroup||evidence?.cgroup;
  if(!group||!group.startsWith('/system.slice/')||group.includes('..')||!group.endsWith('/'+unit))return false;
  try{return /^populated 0$/m.test(await (testing?.readEvents ?? (p=>fs.readFile(p,'utf8')))('/sys/fs/cgroup'+group+'/cgroup.events'));}catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT' && evidence?.terminal===true && fields.InvocationID===evidence.invocationId && group===evidence.cgroup;}
 }};
}
