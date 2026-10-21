/** Trusted local installation only. No shell/sudo fallback. Runner must bound time/output.
 * Store must be launcher-owned, private, canonical, not reachable by command UID.
 * Single manager owner per store: cross-process locking is NOT implemented.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InstalledExecutorMapping } from './workstation-executor-capability.js';
import type { WorkstationServiceManager, ManagedRunSpec, ManagedCredentialLease } from './workstation-managed-executor.js';
import { workstationSystemdRunSpec } from './workstation-systemd-run-spec.js';
type Row={id:string;state:'prepared'|'starting'|'running'|'retained'|'stopped'|'cleaned';cancelled:boolean; mapping?:string; submission?:'none'|'uncertain'|'acknowledged'; invocationId?:string; cgroup?:string; terminal?:boolean;diagnostic?:{phase:string;code:string;exitStatus?:number}};
export interface SystemdRunner {
  pipe?: (args:string[])=>{completed:Promise<{stdout:string;stderr:string}>;disconnect():void};
  run(binary:'/usr/bin/systemd-run'|'/usr/bin/systemctl',args:string[]):Promise<{code:number;stdout:string}>;
  /** Privileged installation probe: must verify policy authorization and cgroup v2. */
  probe(mapping:Readonly<InstalledExecutorMapping>):Promise<{identityVerified:boolean;cgroupOwnership:boolean}>;
  cgroupEmpty(unit:string, evidence?:{invocationId:string;cgroup:string;terminal:boolean}):Promise<boolean>; // Must check cgroup.events; missing unit alone is NOT proof.
}
export function createSystemdWorkstationManager(input:{store:string;mapping:InstalledExecutorMapping;runner:SystemdRunner;fixtureNetworkDeny?:boolean}) {
 const root=fs.realpathSync(input.store),mapping=Object.freeze({...input.mapping});
 const stat=fs.statSync(root);
 if(root!==input.store || root==='/' || (stat.mode&0o077)!==0 || stat.uid!==process.getuid?.())throw new Error('SYSTEMD_STORE_UNSAFE');
 const idPath=(id:string)=>{if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('SYSTEMD_RUN_ID_INVALID');return path.join(root,id);};
 const rowPath=(id:string)=>path.join(idPath(id),'state.json');
 const lockPath=path.join(root,'.manager-lock');
 try{fs.mkdirSync(lockPath,{mode:0o700});fs.writeFileSync(path.join(lockPath,'owner'),String(process.pid),{mode:0o600,flag:'wx'});}catch{throw new Error('SYSTEMD_STORE_LOCKED_REQUIRES_OPERATOR_RECOVERY');}
 let closed=false;
 const assertOpen=()=>{if(closed)throw new Error('SYSTEMD_MANAGER_CLOSED');};
 const binding=JSON.stringify(mapping);
 const rows=new Map<string,Row>(), starts=new Map<string,Promise<void>>();
 const stops=new Map<string,Promise<{empty:boolean}>>();
 const pipes=new Map<string,ReturnType<NonNullable<SystemdRunner['pipe']>>>();
 const syncDirectory=(directory:string)=>{const fd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
 const save=(row:Row)=>{
  const dest=rowPath(row.id),tmp=dest+'.'+randomUUID();
  const fd=fs.openSync(tmp,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(row));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(tmp,dest);
  syncDirectory(idPath(row.id));syncDirectory(root);
  // Publish cache only after durability barriers. An orphan temp is not a committed state.
  rows.set(row.id,row);
 };
 const load=(id:string):Row=>{const r=rows.get(id)??JSON.parse(fs.readFileSync(rowPath(id),'utf8'));if(!r||r.id!==id||r.mapping!==binding||!['prepared','starting','running','retained','stopped','cleaned'].includes(r.state)||typeof r.cancelled!=='boolean'||!['none','uncertain','acknowledged'].includes(r.submission))throw new Error('SYSTEMD_JOURNAL_INVALID');return r;};
 const unit=(id:string)=>`tower-command-${id}.service`;
 const cleanup=(id:string)=>{const row=load(id);if(row.state!=='stopped'&&row.state!=='prepared')throw new Error('SYSTEMD_CLEANUP_NOT_VERIFIED');for(const file of ['env','command','stdout','stderr'])fs.rmSync(path.join(idPath(id),file),{force:true});save({...row,state:'cleaned'});};
 const manager:WorkstationServiceManager={
  probe:m=>input.runner.pipe && JSON.stringify(m)===JSON.stringify(mapping)?input.runner.probe(mapping):Promise.resolve({identityVerified:false,cgroupOwnership:false}),
  async start(spec:ManagedRunSpec){
   assertOpen();
   if(JSON.stringify(spec.mapping)!==JSON.stringify(mapping))throw new Error('SYSTEMD_MAPPING_MISMATCH');
   const row=load(spec.runId);if(row.cancelled||row.state!=='prepared')throw new Error('SYSTEMD_RUN_CANCELLED');
   if(!input.runner.pipe)throw new Error('SYSTEMD_PIPE_UNAVAILABLE');
   fs.writeFileSync(path.join(idPath(spec.runId),'command'),spec.command,{mode:0o600,flag:'wx'});
   save({...row,state:'starting',submission:'uncertain'});
   const plan=workstationSystemdRunSpec({runId:spec.runId,mapping,timeoutSec:spec.timeoutSec,runDirectory:idPath(spec.runId),environmentFile:path.join(idPath(spec.runId),'env'),commandFile:path.join(idPath(spec.runId),'command')});
   const handle=input.runner.pipe([...plan.args.slice(0,-3).filter(a=>!a.startsWith('--property=StandardOutput=')&&!a.startsWith('--property=StandardError=')), '--property=RemainAfterExit=yes','--property=CollectMode=inactive',...(input.fixtureNetworkDeny?['--property=CPUQuota=25%','--property=RestrictAddressFamilies=AF_UNIX','--property=IPAddressDeny=any']:[]),`--property=LoadCredential=command:${path.join(idPath(spec.runId),'command')}`,'--','/bin/sh','-c','exec /bin/sh "$CREDENTIALS_DIRECTORY/command"']);
   pipes.set(spec.runId,handle);void handle.completed.catch(()=>{});
   const completed=(async()=>{
    const deadline=Date.now()+(spec.timeoutSec+5)*1000;
    while(Date.now()<deadline){
     if(load(spec.runId).cancelled)throw new Error('SYSTEMD_RUN_CANCELLED');
     const r=await input.runner.run('/usr/bin/systemctl',['show',unit(spec.runId),'--property=LoadState,InvocationID,ActiveState,SubState,MainPID,ExecMainCode,ExecMainStatus,Result,ControlGroup','--no-pager']);
     if(r.code!==0||r.stdout.length>8192)throw new Error('SYSTEMD_STATUS_UNVERIFIED');
     const f=Object.fromEntries(r.stdout.trim().split('\n').map(x=>x.split('=')));
     if(f.LoadState==='not-found'){await new Promise(r=>setTimeout(r,25));continue;}
     if(f.LoadState==='loaded' && !f.InvocationID && !load(spec.runId).invocationId){await new Promise(r=>setTimeout(r,25));continue;}
     if(f.LoadState!=='loaded'||!/^[a-f0-9]{32}$/.test(f.InvocationID??''))throw new Error('SYSTEMD_IDENTITY_UNVERIFIED');
     const previous=load(spec.runId);if(previous.invocationId&&previous.invocationId!==f.InvocationID)throw new Error('SYSTEMD_INVOCATION_REUSED');
     if(f.ControlGroup && f.ControlGroup!==`/system.slice/${unit(spec.runId)}`)throw new Error('SYSTEMD_CGROUP_MISMATCH');
     const terminal=f.MainPID==='0'&&(f.ActiveState==='failed'||(f.ActiveState==='active'&&f.SubState==='exited'));
     save({...previous,submission:'acknowledged',invocationId:f.InvocationID,cgroup:f.ControlGroup===`/system.slice/${unit(spec.runId)}`?f.ControlGroup:previous.cgroup,terminal,state:'running'});
     if(terminal){
      const code=Number(f.ExecMainStatus);
      if(f.Result!=='success')save({...load(spec.runId),diagnostic:{phase:'service-terminal',code:code===217?'SYSTEMD_EXIT_USER':'SYSTEMD_SERVICE_FAILED',...(Number.isInteger(code)&&code>=0&&code<=255?{exitStatus:code}:{})}});
      const stopped=await manager.stopAndVerify(spec.runId);if(!stopped.empty)throw new Error('SYSTEMD_TERMINATION_UNVERIFIED');
      let timer:ReturnType<typeof setTimeout>;
      try{
       const output=await Promise.race([handle.completed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SYSTEMD_PIPE_DRAIN_TIMEOUT')),3000);})]);
       if(!['1','exited'].includes(f.ExecMainCode)||!['success','exit-code'].includes(f.Result)||!Number.isInteger(code)||code<0||code>255)throw new Error('SYSTEMD_EXECUTION_FAILED');
       return{exitCode:code,...output};
      }finally{clearTimeout(timer!);}
     }
     await new Promise(r=>setTimeout(r,25));
    }throw new Error('SYSTEMD_STATUS_TIMEOUT');
   })().catch(error=>{
    const code=error instanceof Error && /^SYSTEMD_[A-Z_]+$/.test(error.message)?error.message:'SYSTEMD_EXECUTION_UNVERIFIED';
    const row=load(spec.runId);if(!row.diagnostic)save({...row,diagnostic:{phase:'lifecycle',code}});
    throw error;
   });void completed.catch(()=>{});return{completed};
  },
  async stopAndVerify(id){
   assertOpen();
   const existing=stops.get(id);if(existing)return existing;
   const operation=(async()=>{
   let row:Row;try{row=load(id);}catch(error){if(fs.existsSync(idPath(id)))throw error;fs.mkdirSync(idPath(id),{mode:0o700});row={id,state:'prepared',cancelled:true,mapping:binding,submission:'none'};}
   if(row.submission==='none'){save({...row,cancelled:true,state:'stopped'});return{empty:true};}
   save({...row,cancelled:true,state:'retained'});

   // Never wait for client completion or gate readiness before requesting stop.
   const stop=await input.runner.run('/usr/bin/systemctl',['stop',unit(id)]);
   if(stop.code!==0)return{empty:false};
   const check=await input.runner.run('/usr/bin/systemctl',['show',unit(id),'--property=LoadState,InvocationID,ActiveState,MainPID,ControlGroup','--no-pager']);
   const f=Object.fromEntries(check.stdout.trim().split('\n').map(x=>x.split('=')));
   const known=load(id);
   if(check.code!==0||f.LoadState!=='loaded'||f.InvocationID!==known.invocationId||!['inactive','failed'].includes(f.ActiveState)||f.MainPID!=='0'||(f.ControlGroup&&f.ControlGroup!==known.cgroup))return{empty:false};
   save({...known,terminal:true});
   const empty=load(id).submission==='acknowledged' && await input.runner.cgroupEmpty(unit(id),load(id).invocationId&&load(id).cgroup?{invocationId:load(id).invocationId!,cgroup:load(id).cgroup!,terminal:load(id).terminal===true}:undefined);
   save({...load(id),state:empty?'stopped':'retained'});if(!empty)pipes.get(id)?.disconnect();if(empty)pipes.delete(id);return{empty};
   })();stops.set(id,operation);try{const result=await operation;if(!result.empty)stops.delete(id);return result;}catch(error){stops.delete(id);throw error;}
  },
 };
 return {manager,
  close(){if(starts.size||[...rows.values()].some(r=>!['cleaned','stopped'].includes(r.state)))throw new Error('SYSTEMD_START_PENDING');closed=true;fs.rmSync(lockPath,{recursive:true});},
  async prepare(id:string,credentials:Record<string,string>):Promise<ManagedCredentialLease>{
   assertOpen();
   const values=Object.values(credentials);
   if(Object.keys(credentials).length>64||Object.entries(credentials).some(([k,v])=>!(/^[A-Z][A-Z0-9_]{0,63}$/.test(k))||typeof v!=='string'||/[\0\r\n]/.test(v)||v.length>262144||k.startsWith('TOWER_REMOTE_')||/^(HOME|PATH|USER|LOGNAME|SHELL|IFS|ENV|BASH_ENV|LD_.*|SYSTEMD_.*|CREDENTIALS_DIRECTORY)$/.test(k)))throw new Error('SYSTEMD_CREDENTIAL_UNSUPPORTED');
   fs.mkdirSync(idPath(id),{mode:0o700});
   try{save({id,state:'prepared',cancelled:false,mapping:binding,submission:'none'});const quote=(v:string)=>'"'+v.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';fs.writeFileSync(path.join(idPath(id),'env'),Object.entries(credentials).map(([k,v])=>`${k}=${quote(v)}`).join('\n'),{mode:0o600,flag:'wx'});}
   catch(error){fs.rmSync(idPath(id),{recursive:true,force:true});rows.delete(id);throw error;}
   return{env:{...credentials},redaction:{exhaustive:true,values},cleanup:async()=>cleanup(id)};
  },
  async reconcile(){const result:Record<string,string>={};for(const id of fs.readdirSync(root)){if(!/^[a-f0-9-]{36}$/.test(id))continue;try{const row=load(id);if(row.id!==id)throw new Error();if(row.state==='cleaned'){result[id]='cleaned';continue;}if((await manager.stopAndVerify(id)).empty){cleanup(id);result[id]='cleaned';}else result[id]='retained';}catch{result[id]='unverified';}}return result;},
 };
}
