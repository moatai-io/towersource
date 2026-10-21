import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {readFile,lstat,realpath,mkdir,open,rename,symlink,readlink,readdir} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {provisioningSchemaStatus} from './provisioning-schema.js';
import type {ProvisioningHost,ProvisioningCommand,ProvisioningRelease} from './provisioning-command.js';
const exec=promisify(execFile);
export interface ProvisioningHostConfig {directory:string;runtimeDirectory:string;environmentFile:string;unit:string;user:string;port:number;cacheUrl:string;signingPublicKey:string;}
export interface ProvisioningHostRuntime {
 verifySigned(release:Readonly<ProvisioningRelease>):Promise<void>;
 schema(release:Readonly<ProvisioningRelease>,mode:'status'|'apply',baseline?:Readonly<ProvisioningRelease>):Promise<{applied:string[];pending:string[]}>;
 pin(release:Readonly<ProvisioningRelease>,root:string):Promise<void>;
 systemctl(action:'start'|'stop'|'show'|'daemon-reload',unit:string):Promise<string>;
 health(port:number,release:Readonly<ProvisioningRelease>):Promise<boolean>;
}
interface Identity {instanceId:string;attemptId:string;approvalHash:string;release:ProvisioningRelease;}
interface HostState {version:1;phase:'intent'|'started'|'stopped'|'adopted';identity:Identity;}
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const canonical=(v:unknown):string=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')}}`:JSON.stringify(v);
async function regular(filename:string,max=65536):Promise<Buffer>{
 const f=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=await f.stat();if(!st.isFile()||st.size>max)throw Error('provisioning_file_invalid');return await f.readFile();}finally{await f.close();}
}
async function migrationHash(root:string):Promise<string>{
 const directory=path.join(root,'lib/tower/packages/backend/db/migrations'),names=(await readdir(directory)).filter(n=>n.endsWith('.sql')).sort();
 if(names.length>5000||names.some(n=>!/^[A-Za-z0-9_.-]+\.sql$/.test(n)))throw Error('provisioning_migration_set_invalid');
 const h=createHash('sha256');for(const n of names){h.update(n);h.update('\0');h.update(await regular(path.join(directory,n),1024*1024));h.update('\0');}return h.digest('hex');
}
/** Production runtime: no shell command from a request; full recursive Nix verification. */
export function nativeProvisioningRuntime(c:ProvisioningHostConfig):ProvisioningHostRuntime{
 const environment=async()=>{
  const st=await lstat(c.environmentFile);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||st.uid!==process.getuid?.())throw Error('provisioning_environment_invalid');
  const lines=(await regular(c.environmentFile)).toString('utf8').split('\n');const env:NodeJS.ProcessEnv={PATH:process.env.PATH};
  // Canonical environment uses literal KEY=value; no sourcing shell syntax.
  for(const line of lines){if(!line.trim()||line.startsWith('#'))continue;const m=/^([A-Z][A-Z0-9_]*)=([^\r\n]*)$/.exec(line);if(!m||/^["']/.test(m[2])||/^(NODE_OPTIONS|LD_PRELOAD|BASH_ENV|ENV|PATH|HOME|SOURCE_REV|GIT_SHA|BUILD_TIME|FLAKE_LOCK_NAR_HASH|TOWER_(NIX_|FRESH_|APP_ROOT$|HOST_ROLLBACK|PRODUCTION_ACK$|RUNTIME_CWD$))/.test(m[1]))throw Error('provisioning_environment_invalid');env[m[1]]=m[2];}
  if(env.NO_AUTH!=='false'||!env.DATABASE_URL||!/^(postgres|postgresql):\/\//.test(env.DATABASE_URL))throw Error('provisioning_environment_invalid');return env;
 };
 return {
  async verifySigned(r){
   const keyId=c.signingPublicKey.split(':')[0];
   const raw=await exec('nix',['--extra-experimental-features','nix-command','path-info','--json',r.closurePath],{timeout:60000,maxBuffer:1024*1024});
   const parsed=JSON.parse(raw.stdout);const info=Array.isArray(parsed)?parsed[0]:parsed[r.closurePath];
   if(!info||!Array.isArray(info.signatures)||!info.signatures.some((s:unknown)=>typeof s==='string'&&s.startsWith(keyId+':'))||typeof info.narHash!=='string')throw Error('provisioning_release_signature_missing');
   await exec('nix',['--extra-experimental-features','nix-command','store','verify','--sigs-needed','1','--option','trusted-public-keys',c.signingPublicKey,r.closurePath],{timeout:300000,maxBuffer:1024*1024});
   await exec('nix',['--extra-experimental-features','nix-command','store','verify','--recursive','--no-trust',r.closurePath],{timeout:300000,maxBuffer:1024*1024});
   const manifest=JSON.parse((await regular(path.join(r.closurePath,'share/tower/release-manifest.json'))).toString('utf8'));
   if(manifest.sourceRev!==r.sourceRev||manifest.package!=='tower-app')throw Error('provisioning_release_identity_invalid');
   const migrationSetHash=await migrationHash(r.closurePath);
   const body={sourceRev:r.sourceRev,version:manifest.version,system:'x86_64-linux',closurePath:r.closurePath,closureNarHash:'sha256:'+ (await exec('nix',['--extra-experimental-features','nix-command','hash','to-base32','--type','sha256',info.narHash],{timeout:10000,maxBuffer:4096})).stdout.trim(),cacheUrl:c.cacheUrl,signingKeyId:keyId,migrationSetHash};
   if(createHash('sha256').update(canonical(body)).digest('hex')!==r.digest)throw Error('provisioning_release_digest_invalid');
   const launcher=path.join(r.closurePath,'bin/tower-app-start-provisioning');const s=await lstat(launcher);if(!s.isFile()||!(s.mode&0o111))throw Error('provisioning_launcher_missing');
   const env=await environment(); // Prevent NO_AUTH, invalid secrets/config before any service mutation.
   if(env.HOST!=='127.0.0.1'||env.PORT!==String(c.port)||!env.PUBLIC_URL?.startsWith('https://'))throw Error('provisioning_environment_invalid');
  },
  async pin(r,root){await exec('nix-store',['--add-root',root,'--indirect','-r',r.closurePath],{timeout:60000,maxBuffer:65536});},
  async schema(r,mode,baseline){
   const env=await environment();
   const status=()=>provisioningSchemaStatus(env.DATABASE_URL!,path.join(r.closurePath,'lib/tower/packages/backend/db/migrations'),baseline?path.join(baseline.closurePath,'lib/tower/packages/backend/db/migrations'):undefined);
   if(mode==='status')return status();const file=path.join(r.closurePath,'lib/tower/dist/backend/packages/backend/scripts/apply-db-migrations.js');
   const result=await exec(process.execPath,[file,mode],{env:{...env,TOWER_PROJECT_ROOT:c.runtimeDirectory,WORKSPACE_ROOT:path.join(c.runtimeDirectory,'workspace'),DEFAULT_CWD:path.join(c.runtimeDirectory,'workspace'),TOWER_DATA_DIR:path.join(c.runtimeDirectory,'data')},timeout:300000,maxBuffer:1024*1024});
   // The existing product CLI logs initialization and summaries. Re-read native history instead of guessing its stdout schema.
   void result;return status();
  },
  async systemctl(action,unit){if(action==='start'||action==='daemon-reload'){const link='/etc/systemd/system/'+c.unit,st=await lstat(link);if(!st.isSymbolicLink()||await readlink(link)!==path.join(c.directory,'units',c.unit))throw Error('provisioning_systemd_binding_invalid');}const result=await exec('systemctl',action==='daemon-reload'?['daemon-reload']:action==='show'?['show',unit,'--property=ActiveState,SubState,ExecStart,MainPID,ControlPID,ControlGroup']: [action,unit],{timeout:60000,maxBuffer:65536});return result.stdout;},
  async health(port,r){
   for(let n=0;n<30;n++){
    try{const response=await fetch(`http://127.0.0.1:${port}/api/health`,{redirect:'error',signal:AbortSignal.timeout(1000)});if(response.ok){const body=await response.text();if(body.length<=65536){const d=JSON.parse(body);if(d.status==='ok'&&d.sourceRev===r.sourceRev&&d.metadataSource==='injected')return true;}}}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
   }return false;
  },
 };
}
/** Roots and unit name are host-trusted config, never caller payload. Construct under authority lock. */
export async function provisioningHost(c:ProvisioningHostConfig,runtime:ProvisioningHostRuntime=nativeProvisioningRuntime(c)):Promise<ProvisioningHost>{
 for(const dir of [c.directory,c.runtimeDirectory]){const st=await lstat(dir);if(!path.isAbsolute(dir)||await realpath(dir)!==dir||!st.isDirectory()||(dir===c.directory&&st.uid!==process.getuid?.())||(st.mode&0o022)!==0)throw Error('provisioning_host_config_invalid');}
 const envStat=await lstat(c.environmentFile);
 if(!path.isAbsolute(c.environmentFile)||await realpath(c.environmentFile)!==c.environmentFile||!envStat.isFile()||(envStat.mode&0o077)!==0||envStat.uid!==process.getuid?.()||!/^[a-z][a-z0-9-]{0,79}\.service$/.test(c.unit)||!/^[a-z_][a-z0-9_-]{0,31}$/.test(c.user)||!Number.isInteger(c.port)||c.port<1024||c.port>65535||!/^https:\/\/[^\s]+$/.test(c.cacheUrl)||!/^[A-Za-z0-9_-]{1,120}:[A-Za-z0-9+/]{43}=$/.test(c.signingPublicKey)||[c.directory,c.runtimeDirectory,c.environmentFile].some(x=>/[\s\r\n"\\%]/.test(x)))throw Error('provisioning_host_config_invalid');
 const roots=path.join(c.directory,'gcroots');await mkdir(roots,{recursive:true,mode:0o700});
 const rootsStat=await lstat(roots);if(rootsStat.isSymbolicLink()||await realpath(roots)!==roots||(rootsStat.mode&0o077)!==0)throw Error('provisioning_gcroot_invalid');
 const unitDir=path.join(c.directory,'units');await mkdir(unitDir,{recursive:true,mode:0o700});const unitDirStat=await lstat(unitDir);if(unitDirStat.isSymbolicLink()||await realpath(unitDir)!==unitDir||unitDirStat.uid!==process.getuid?.()||(unitDirStat.mode&0o077)!==0)throw Error('provisioning_unit_directory_invalid');
 const filename=path.join(c.directory,'host-state.json'),current=path.join(c.directory,'current.json');
 async function write(file:string,data:unknown){const temp=file+'.pending',f=await open(temp,'wx',0o600);try{await f.writeFile(JSON.stringify(data)+'\n');await f.sync();}finally{await f.close();}await rename(temp,file);const d=await open(c.directory,'r');try{await d.sync();}finally{await d.close();}}
 async function read<T>(file:string):Promise<T|null>{try{return JSON.parse((await regular(file)).toString('utf8')) as T;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
 const same=(a:ProvisioningRelease|null,b:ProvisioningRelease|null)=>a===null?b===null:b!==null&&a.digest===b.digest&&a.sourceRev===b.sourceRev&&a.closurePath===b.closurePath;
 const identity=(cmd:Readonly<ProvisioningCommand>):Identity=>({instanceId:cmd.instanceId,attemptId:cmd.attemptId,approvalHash:cmd.approvalHash,release:{...cmd.release!}});
 async function baseline(cmd:Readonly<ProvisioningCommand>){const old=await read<Identity>(current);if(old&&old.instanceId!==cmd.instanceId||!same(old?.release??null,cmd.baseline))throw Error('provisioning_baseline_conflict');}
 async function pin(name:string,release:ProvisioningRelease){const file=path.join(roots,name);try{await runtime.pin(release,file);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||await readlink(file)!==release.closurePath)throw Error('provisioning_pin_conflict');}const d=await open(roots,'r');try{await d.sync();}finally{await d.close();}}
 async function service(){
  const s=await runtime.systemctl('show',c.unit);const value=(key:string)=>new RegExp('^'+key+'=(.*)$','m').exec(s)?.[1];
  const main=value('MainPID'),control=value('ControlPID');let empty=false;const group=value('ControlGroup');
  if(group==='')empty=true;
  else if(group&&/^\/[A-Za-z0-9_.@/\x2d]+$/.test(group)&&!group.includes('..')){
   try{empty=(await readFile(path.join('/sys/fs/cgroup',group,'cgroup.procs'),'utf8')).trim()==='';}catch{empty=false;}
  }
  return {active:value('ActiveState')==='active',failed:value('ActiveState')==='failed',inactive:value('ActiveState')==='inactive',quiescent:main==='0'&&control==='0'&&empty,exec:s};
 }
 async function stopOwned(r:ProvisioningRelease){const before=await service();if((before.active||before.failed||!before.quiescent)&&!before.exec.includes(r.closurePath+'/bin/tower-app-start-provisioning'))throw Error('provisioning_stop_unowned_service');await runtime.systemctl('stop',c.unit);const after=await service();if(!after.inactive||!after.quiescent)throw Error('provisioning_stop_readback_failed');}

 async function observe(cmd:Readonly<ProvisioningCommand>){const s=await read<HostState>(filename);if(!s||s.identity.instanceId!==cmd.instanceId||s.identity.attemptId!==cmd.attemptId||s.identity.approvalHash!==cmd.approvalHash)throw Error('provisioning_host_identity_conflict');const d=await service(),r=s.identity.release;let state:'active'|'inactive'|'failed'|'unknown'='unknown';
  if(d.inactive&&d.quiescent)state='inactive';else if(d.active&&d.exec.includes(r.closurePath+'/bin/tower-app-start-provisioning'))state=await runtime.health(c.port,r)?'active':'failed';else if(d.failed&&d.exec.includes(r.closurePath+'/bin/tower-app-start-provisioning'))state='failed';
  return {instanceId:cmd.instanceId,attemptId:cmd.attemptId,sourceRev:r.sourceRev,digest:r.digest,state,evidenceId:hash({s,d,state})};
 }
 return {
  verify:r=>runtime.verifySigned(r),observe,
  async start(cmd,fence){
   const r=cmd.release!;await fence();await baseline(cmd);const prior=await read<HostState>(filename),d=await service();
   if(prior&&(prior.identity.instanceId!==cmd.instanceId||prior.phase==='intent'||(prior.phase==='started'&&prior.identity.attemptId!==cmd.attemptId)||(!same(prior.identity.release,cmd.baseline)&&!same(prior.identity.release,r)&&!(prior.phase==='stopped'&&prior.identity.attemptId===cmd.attemptId&&same(r,cmd.baseline)))))throw Error('provisioning_host_reconciliation_required');
   if(d.active&&(!prior||!d.exec.includes(prior.identity.release.closurePath+'/bin/tower-app-start-provisioning')))throw Error('provisioning_unowned_service');
   if(cmd.baseline)await runtime.verifySigned(cmd.baseline);
   const status=await runtime.schema(r,'status',cmd.baseline??undefined);
   if(cmd.operation==='install'){if(status.applied.length!==0)throw Error('provisioning_fresh_database_not_empty');}
   else if(status.pending.length!==0)throw Error('provisioning_update_schema_change_requires_separate_plan');
   await pin(cmd.attemptId+'-'+r.digest,r);if(cmd.baseline)await pin(cmd.attemptId+'-previous',cmd.baseline);
   await write(filename,{version:1,phase:'intent',identity:identity(cmd)} satisfies HostState);
   if(cmd.operation==='install'){await fence();await runtime.schema(r,'apply');if((await runtime.schema(r,'status')).pending.length)throw Error('provisioning_migrations_incomplete');}
   await fence();if(prior)await stopOwned(prior.identity.release);else if(!d.inactive||!d.quiescent)throw Error('provisioning_service_not_quiescent');
   // unit directory is created/protected by the privileged bootstrap owner.

   const unit=`[Unit]\nDescription=Tower provisioning-only\nAfter=network-online.target\n[Service]\nType=simple\nUser=${c.user}\nWorkingDirectory=${c.runtimeDirectory}\nEnvironmentFile=${c.environmentFile}\nEnvironment=TOWER_RUN_MODE=nix-production\nEnvironment=HOST=127.0.0.1\nEnvironment=PORT=${c.port}\nEnvironment=NODE_ENV=production\nEnvironment=TOWER_RUNTIME_CWD=${c.runtimeDirectory}\nEnvironment=TOWER_PROJECT_ROOT=${c.runtimeDirectory}\nEnvironment=WORKSPACE_ROOT=${c.runtimeDirectory}/workspace\nEnvironment=DEFAULT_CWD=${c.runtimeDirectory}/workspace\nEnvironment=TOWER_DATA_DIR=${c.runtimeDirectory}/data\nEnvironment=TOWER_NIX_PRODUCTION_PROFILE=authority\nEnvironment=TOWER_NIX_PRODUCTION_ACK=${r.sourceRev}\nEnvironment=TOWER_NIX_RECOVERY_MODE=${cmd.mode}\nEnvironment=TOWER_FRESH_INSTALL_ACK=${r.sourceRev}\nEnvironment=TOWER_FRESH_AUTHORITY_ACK=${r.sourceRev}\nEnvironment=TOWER_FRESH_RECOVERY_POLICY=stop-and-preserve\nEnvironment=TOWER_NIX_CURRENT_ACK=${r.sourceRev}\nExecStartPre=${r.closurePath}/bin/tower-app-start-provisioning check\nExecStart=${r.closurePath}/bin/tower-app-start-provisioning run\nRestart=no\nKillMode=control-group\nDelegate=no\nUMask=0077\nNoNewPrivileges=yes\n`;
   const unitFile=path.join(unitDir,c.unit),tmp=unitFile+'.pending',f=await open(tmp,'wx',0o600);try{await f.writeFile(unit);await f.sync();}finally{await f.close();}await rename(tmp,unitFile);
   // Production bootstrap preinstalls a symlink /etc/systemd/system/<unit> -> this exact unitFile.
   await fence();await runtime.systemctl('daemon-reload',c.unit);await fence();await runtime.systemctl('start',c.unit);await write(filename,{version:1,phase:'started',identity:identity(cmd)} satisfies HostState);return hash({action:'start',identity:identity(cmd)});
  },
  async stopExact(cmd,fence){await fence();const s=await read<HostState>(filename);if(!s||s.identity.instanceId!==cmd.instanceId||s.identity.attemptId!==cmd.attemptId||!same(s.identity.release,cmd.release!))throw Error('provisioning_stop_identity_conflict');await stopOwned(cmd.release!);await write(filename,{...s,phase:'stopped'});return hash({action:'stop',identity:identity(cmd)});},
  async adopt(cmd,fence){await fence();await baseline(cmd);const o=await observe(cmd);if(o.state!=='active'||o.digest!==cmd.release!.digest||o.sourceRev!==cmd.release!.sourceRev)throw Error('provisioning_adopt_readback_failed');await pin(cmd.release!.digest,cmd.release!);await fence();await write(current,identity(cmd));await write(filename,{version:1,phase:'adopted',identity:identity(cmd)} satisfies HostState);return o.evidenceId;},
 };
}
