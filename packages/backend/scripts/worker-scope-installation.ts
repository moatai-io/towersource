import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { digest } from './worker-scope-assignment-lifecycle.js';
import type { ScopeRuntimePolicy } from './worker-scope-runtime-observer.js';
import { assertRootProbeState } from '../services/runtime-box/worker-scope-execution-probe.js';
import { runScopeSystemctl, type SystemctlRunner } from './worker-scope-heartbeat-adapter.js';

/** Operator-provisioned policy, never manufactured by the reconciler. Secrets
 * live in systemd's existing EnvironmentFile, not this JSON or renderer output. */
export interface ScopeInstallationPolicy extends ScopeRuntimePolicy {
  actorUserId:number; stagingDirectory:string; backendPolicyFile:string;
  backendUrl:string; nodeBinary:string; environmentFile:string;
}
export function scopeWritableDirectories(c:ScopeRuntimePolicy) {
  return [...new Set([path.dirname(c.configFile),path.dirname(c.identityFile),path.dirname(c.stateFile),c.backupDirectory,path.dirname(c.heartbeatFragment)])];
}
export function scopeCliEntrypoint(c:ScopeRuntimePolicy) {return `${c.storePath}/lib/tower/dist/backend/packages/backend/scripts/worker-scope-cli.js`;}
export function validateScopeInstallationPolicy(c:ScopeInstallationPolicy) {
  const absolute=(v:unknown):v is string=>typeof v==='string'&&/^\/[A-Za-z0-9_./-]+$/.test(v)&&path.resolve(v)===v&&v!=='/';
  if(c.version!==1||!/^[A-Za-z0-9_-]+$/.test(c.workerId)||!/^[A-Za-z0-9_-]+$/.test(c.deploymentId)||c.deploymentId==='development'
    || ![c.executionUid,c.executionGid,c.actorUserId].every(n=>Number.isSafeInteger(n)&&n>0)
    || !/^\/nix\/store\/[a-z0-9]{32}-[^/\s]+$/.test(c.storePath)||!/^[a-f0-9]{40}$/.test(c.sourceRev)
    || !/^\/nix\/store\/[a-z0-9]{32}-[^/\s]+\/bin\/node$/.test(c.nodeBinary)
    || c.workerUnit!==`tower-workbench-worker-${c.workerId}.service`||c.heartbeatUnit!==`tower-workbench-worker-${c.workerId}-heartbeat.service`
    ||c.coordinatorUnit!==`tower-worker-scope-${c.workerId}.service`)throw new Error('SCOPE_INSTALL_POLICY_INVALID');
  for(const key of ['workerFragment','heartbeatFragment','coordinatorFragment','configFile','identityFile','stateFile','lockFile','backupDirectory','projectsRoot','stagingDirectory','backendPolicyFile','environmentFile'] as const)if(!absolute(c[key]))throw new Error('SCOPE_INSTALL_PATH_INVALID');
  for(const url of [c.baseUrl,c.controlPlaneUrl,c.backendUrl])if(!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(url))throw new Error('SCOPE_INSTALL_ENDPOINT_INVALID');
  if(c.controlPlaneUrl!==c.backendUrl || path.basename(c.workerFragment)!==c.workerUnit || path.basename(c.heartbeatFragment)!==c.heartbeatUnit
    ||path.basename(c.coordinatorFragment)!==c.coordinatorUnit)throw new Error('SCOPE_INSTALL_UNIT_MAPPING_INVALID');
  // Atomic rename requires a writable parent. Never grant write access to the
  // system unit tree, home root, workspace root or immutable store as a shortcut.
  for(const p of scopeWritableDirectories(c))if(p.split('/').length<4 || ['/etc/systemd/system','/etc','/run','/var','/var/lib','/home',c.projectsRoot,path.dirname(c.projectsRoot)].includes(p)
    ||p.startsWith('/nix/store/'))throw new Error('SCOPE_INSTALL_WRITABLE_PARENT_TOO_BROAD');
  if(!c.stagingDirectory.startsWith(c.backupDirectory+'/'))throw new Error('SCOPE_INSTALL_STAGE_OUTSIDE_BACKUP');
}
export function assertScopeInstalledFile(file:string) {
  for(let p=file;;p=path.dirname(p)){const st=fs.lstatSync(p);
    if(st.uid!==0||st.isSymbolicLink()||st.mode&0o022||(p===file&&(!st.isFile()||st.nlink!==1)))throw new Error('SCOPE_INSTALL_FILE_UNTRUSTED');
    if(p===path.dirname(p))break;
  }
}
/** Control-plane secrets must never inherit the execution group's 0640 contract. */
export function assertScopeCoordinatorEnvironment(file:string) {
  assertScopeInstalledFile(file); const st=fs.lstatSync(file);
  if(st.uid!==0 || st.gid!==0 || (st.mode&0o7777)!==0o600)throw new Error('SCOPE_INSTALL_ENVIRONMENT_ROOT_ONLY_REQUIRED');
}
export function preflightScopeTools() {
  for(const [command,args] of [['flock',['--version']],['getconf',['CLK_TCK']],['systemctl',['--version']]] as const) {
    const result=spawnSync(command,[...args],{stdio:'ignore',timeout:5000});
    if(result.error || result.signal || result.status!==0)throw new Error(command==='flock'?'SCOPE_LOCK_EXECUTION_FAILED':'SCOPE_INSTALL_TOOL_UNAVAILABLE');
  }
}
export function loadScopeInstallationPolicy(file:string, trusted=assertRootProbeState):ScopeInstallationPolicy {
  trusted(file);const c=JSON.parse(fs.readFileSync(file,'utf8'));validateScopeInstallationPolicy(c);return c;
}
/** Pure renderer, no install/enable/reload. The caller supplies an explicit mode;
 * default output is a read-only diagnostic job, not an enabled mutation timer. */
export function renderScopeCoordinatorUnit(c:ScopeInstallationPolicy,policyFile:string,mode:'preflight'|'apply'|'recover'='preflight'):string {
  validateScopeInstallationPolicy(c);
  if(!/^\/[A-Za-z0-9_./-]+$/.test(policyFile)||path.resolve(policyFile)!==policyFile)throw new Error('SCOPE_INSTALL_POLICY_PATH_INVALID');
  return `[Unit]\nDescription=Tower fenced scope assignment ${c.workerId}\nAfter=network.target ${c.workerUnit} ${c.heartbeatUnit}\n\n[Service]\nType=exec\nUser=root\nGroup=root\nEnvironmentFile=${c.environmentFile}\nExecStart=${c.nodeBinary} ${scopeCliEntrypoint(c)} --policy ${policyFile} --${mode}\nProtectSystem=strict\nProtectHome=read-only\nNoNewPrivileges=yes\nReadWritePaths=${scopeWritableDirectories(c).join(' ')}\nKillMode=process\nSendSIGKILL=no\nTimeoutStopSec=infinity\nRestart=no\n`;
}
export async function inspectScopeInstallation(c:ScopeInstallationPolicy,policyFile:string, options:{trusted?:(file:string)=>void;runner?:SystemctlRunner}={}) {
  const trusted=options.trusted??assertScopeInstalledFile,run=options.runner??runScopeSystemctl;
  validateScopeInstallationPolicy(c);trusted(policyFile);
  for(const p of [c.configFile,c.identityFile,c.stateFile,c.lockFile,c.workerFragment,c.heartbeatFragment,c.coordinatorFragment,c.backendPolicyFile,c.environmentFile,scopeCliEntrypoint(c),c.nodeBinary])trusted(p);
  // Directory checks don't use the regular-file-only journal verifier.
  for(const dir of [c.backupDirectory,c.stagingDirectory,...scopeWritableDirectories(c)]) {
    let p=dir;for(;;){const st=fs.lstatSync(p);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==0||st.mode&0o022)throw new Error('SCOPE_INSTALL_DIRECTORY_UNTRUSTED');const parent=path.dirname(p);if(parent===p)break;p=parent;}
    fs.accessSync(dir,fs.constants.R_OK|fs.constants.W_OK|fs.constants.X_OK);
  }
  for(const p of [c.backupDirectory,c.stagingDirectory])if(fs.statSync(p).mode&0o077)throw new Error('SCOPE_INSTALL_PRIVATE_DIRECTORY_REQUIRED');
  assertScopeCoordinatorEnvironment(c.environmentFile);
  preflightScopeTools();
  const manifest=path.join(c.storePath,'share/tower/release-manifest.json');trusted(manifest);
  if(JSON.parse(fs.readFileSync(manifest,'utf8')).sourceRev!==c.sourceRev)throw new Error('SCOPE_INSTALL_REVISION_MISMATCH');
  const unit=fs.readFileSync(c.coordinatorFragment,'utf8');
  if(!(['preflight','apply','recover'] as const).some(mode=>renderScopeCoordinatorUnit(c,policyFile,mode)===unit))throw new Error('SCOPE_INSTALL_COORDINATOR_DRIFT');
  const properties=Object.fromEntries((await run(['show',c.coordinatorUnit,'--property=ExecStart,FragmentPath,DropInPaths,NeedDaemonReload,LoadState'])).trim().split('\n').map(l=>{const n=l.indexOf('=');return [l.slice(0,n),l.slice(n+1)];}));
  if(properties.FragmentPath!==c.coordinatorFragment||properties.DropInPaths!==''||properties.LoadState!=='loaded'||properties.NeedDaemonReload!=='no'
    || !properties.ExecStart?.includes(`path=${c.nodeBinary} ;`)||!properties.ExecStart.includes(`${scopeCliEntrypoint(c)} --policy ${policyFile} --`))throw new Error('SCOPE_INSTALL_LOADED_COORDINATOR_MISMATCH');
  return {policyDigest:digest(fs.readFileSync(policyFile)),sourceRev:c.sourceRev};
}

/** Review artifact only: caller must explicitly install/enable this timer. */
export function renderScopeCoordinatorTimer(c:ScopeInstallationPolicy):string {
  validateScopeInstallationPolicy(c);
  return `[Unit]\nDescription=Tower pending scope assignment ${c.workerId}\n\n[Timer]\nOnBootSec=30s\nOnUnitInactiveSec=30s\nAccuracySec=5s\nUnit=${c.coordinatorUnit}\n\n[Install]\nWantedBy=timers.target\n`;
}

/** Pure relocation plan. The operator installs a protected regular file at the
 * target and a systemd link at the original name only after explicit approval.
 * The policy uses the real fragment target, never the systemd symlink. Existing
 * drop-ins retain their precedence and are separately inventoried by the adapter.
 */
export function planScopeHeartbeatRelocation(workerId:string, currentFragment:string, source:string) {
  if(!/^[A-Za-z0-9_-]+$/.test(workerId))throw new Error('SCOPE_INSTALL_WORKER_INVALID');
  const unit=`tower-workbench-worker-${workerId}-heartbeat.service`;
  const link=`/etc/systemd/system/${unit}`;
  const directory=`/etc/tower-worker-scope-units/${workerId}`;
  const target=`${directory}/${unit}`;
  if(currentFragment!==link && currentFragment!==target)throw new Error('SCOPE_INSTALL_FRAGMENT_UNSUPPORTED');
  // Relocation must not silently change the interpretation of relative paths or
  // specifiers whose value depends on the fragment path (notably %y and %Y).
  if(source.includes('%') || /\\\r?\n/.test(source))throw new Error('SCOPE_INSTALL_RELOCATION_COMPLEX_UNIT');
  if(!/^\[Service\]$/m.test(source))throw new Error('SCOPE_INSTALL_SERVICE_SECTION_REQUIRED');
  return {unit,link,target,directory,content:source,sha256:digest(source),
    changed:currentFragment!==target,directoryMode:0o755,fileMode:0o644,
    rollback:'Restore the saved regular unit at link, reload systemd, then verify FragmentPath and effective configuration.'};
}
