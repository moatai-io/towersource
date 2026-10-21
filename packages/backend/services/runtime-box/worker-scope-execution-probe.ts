import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import type http from 'node:http';
import { digest, assertScopeExecutionBinding, executionBindingDigest, scopeDigest, protectedPath, type AssignmentOperation, type ProjectExecutionReceipt } from '../../scripts/worker-scope-assignment-lifecycle.js';
import type { WorkerMaintenanceGate } from './worker-maintenance-gate.js';

/** No public command/path/project/env input. All endpoints take an owner header
 * only. The installed controller journals executionNonce before calling them.
 * Losing an in-memory session leaves a uniquely named scratch for explicit review,
 * never recursively removes an unknown/replaced directory or releases the fence. */
export interface ScopeProbeContext {
  owner: string; projectId: string; root: string; rootIdentity: { dev: number; ino: number };
  workerId: string; pid: number; nonce: string; operationDigest: string; scopeDigest: string;
}
export interface ScopeProbeInstallation {
  stateFile: string; workerId: string; projects: Record<string, string>;
  /** Bootstrap-only test seam for root metadata; not an HTTP/JSON option. */
  assertTrustedState?: (file: string) => void;
}
export function assertRootProbeState(file: string) {
  protectedPath(file);
  for (let p = file; ; p = path.dirname(p)) {
    const st = fs.lstatSync(p);
    if (st.uid !== 0 || st.mode & 0o022 || st.isSymbolicLink()) throw new Error('SCOPE_PROBE_UNTRUSTED_STATE');
    if (p === file && (!st.isFile() || st.nlink !== 1 || st.size > 128 * 1024)) throw new Error('SCOPE_PROBE_UNTRUSTED_STATE');
    if (p === path.dirname(p)) break;
  }
}
export function readScopeProbeContext(installation: ScopeProbeInstallation, owner: string): ScopeProbeContext {
  (installation.assertTrustedState ?? assertRootProbeState)(installation.stateFile);
  const state = JSON.parse(fs.readFileSync(installation.stateFile, 'utf8'));
  const op = state.operation as AssignmentOperation;
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(owner) || state.version !== 1 || state.owner !== owner || op?.id !== owner
    || op.kind !== 'scope-assignment' || op.version !== 1 || op.phase !== 'probe-intent' || op.workerId !== installation.workerId
    || !/^[a-zA-Z0-9_-]+$/.test(op.projectId) || !/^[a-f0-9-]{36}$/.test(op.executionNonce ?? '')
    || !Number.isSafeInteger(op.livePid) || op.livePid! <= 0 || !op.newJti) throw new Error('SCOPE_PROBE_JOURNAL_INVALID');
  const root = installation.projects[op.projectId];
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root || fs.realpathSync(root) !== root
    || root !== op.newScope?.[op.projectId] || scopeDigest(installation.projects) !== scopeDigest(op.newScope)) throw new Error('SCOPE_PROBE_SCOPE_MISMATCH');
  const st = fs.lstatSync(root);
  if (!st.isDirectory() || st.dev !== op.rootIdentity?.dev || st.ino !== op.rootIdentity?.ino) throw new Error('SCOPE_PROBE_ROOT_REPLACED');
  return { owner, projectId: op.projectId, workerId: op.workerId, root, rootIdentity: {dev:st.dev,ino:st.ino}, pid:op.livePid!,
    nonce:op.executionNonce!, operationDigest:executionBindingDigest(op), scopeDigest:scopeDigest(op.newScope) };
}
export function scopeProbeDirectory(c: ScopeProbeContext) { return `.tower-scope-exec-${c.nonce}`; }
function equalContext(a: ScopeProbeContext, b: ScopeProbeContext) { if (JSON.stringify(a)!==JSON.stringify(b)) throw new Error('SCOPE_PROBE_CONTEXT_CHANGED'); }
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
export interface ScratchIdentity { dev: number; ino: number }
export type CommandStage = 'prepare' | 'verify' | 'cleanup' | 'abort';
/** Fixed JS runs through the Worker's normal executeRun (or installed executor),
 * never exec/spawn in this helper or a general HTTP run endpoint. Only constants
 * obtained from the protected journal/session are interpolated and shell-quoted.
 * Normal creation mode/umask/default ACLs are retained: no chmod permission fix. */
export function fixedScopeProbeCommand(c: ScopeProbeContext, stage: CommandStage, scratch?: ScratchIdentity): string {
  const code = `const fs=require('node:fs');
const c=${JSON.stringify({ rootIdentity:c.rootIdentity, nonce:c.nonce, operationDigest:c.operationDigest })};
const dir=${JSON.stringify(scopeProbeDirectory(c))}; const stage=${JSON.stringify(stage)}; const expected=${JSON.stringify(scratch ?? null)};
const st=fs.statSync('.');if(st.dev!==c.rootIdentity.dev||st.ino!==c.rootIdentity.ino)throw Error('ROOT');
let anchor;
const safe=(p)=>{const s=fs.lstatSync(p);if(!s.isFile()||s.nlink!==1||s.isSymbolicLink()||s.size>1024)throw Error('FILE');return s;};
const read=(name)=>{safe(anchor+'/'+name);const fd=fs.openSync(anchor+'/'+name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{return fs.readFileSync(fd,'utf8')}finally{fs.closeSync(fd)}};
const create=(name,value)=>{const fd=fs.openSync(anchor+'/'+name,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o666);try{fs.writeFileSync(fd,value)}finally{fs.closeSync(fd)}};
const worker='worker:'+c.operationDigest, backend='backend:'+c.operationDigest;
if(stage==='prepare')fs.mkdirSync(dir);
const d=fs.lstatSync(dir);if(!d.isDirectory()||d.isSymbolicLink()||(expected&&(d.dev!==expected.dev||d.ino!==expected.ino)))throw Error('SCRATCH');
const dirfd=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
const pinned=fs.fstatSync(dirfd);if(pinned.dev!==d.dev||pinned.ino!==d.ino)throw Error('SCRATCH_CHANGED');anchor='/proc/self/fd/'+dirfd;
if(stage==='prepare')create('shared',worker);
if(stage==='verify'){if(read('shared')!==backend||read('backend')!==backend)throw Error('BACKEND');create('worker-ack',worker);}
if(stage==='cleanup' && read('backend-ack')!==backend)throw Error('BACKEND_FINAL_ACK');
if(stage==='cleanup'||stage==='abort'){
const allowed=['shared','backend','worker-ack','backend-ack'];
const names=fs.readdirSync(anchor);if(names.some(n=>!allowed.includes(n)))throw Error('UNKNOWN_FILE');
for(const n of names)safe(anchor+'/'+n);
for(const n of names)fs.unlinkSync(anchor+'/'+n);const last=fs.lstatSync(dir);if(last.dev!==d.dev||last.ino!==d.ino)throw Error('SCRATCH_CHANGED');fs.rmdirSync(dir);
}
fs.closeSync(dirfd);
process.stdout.write(JSON.stringify({nonce:c.nonce,dev:d.dev,ino:d.ino,stage,uid:process.getuid(),gid:process.getgid()}));`;
  // The immutable Node executable used by the Worker is available in the same
  // /nix/store mount in both native and sandbox execution profiles.
  return `${quote(process.execPath)} -e ${quote(code)}`;
}
export interface FixedExecutionResult { exitCode: number; stdout: string; stderr: string; cleanupComplete: true; processGroupExited: true }
/** Converts normal executeRun NDJSON to a strict bounded result, keeping ordinary
 * execution/cancellation/credential-cleanup behavior in the shared server. */
export async function captureScopeExecuteRun(run: (response: http.ServerResponse) => Promise<void>): Promise<FixedExecutionResult> {
  const chunks: Buffer[]=[]; let size=0;
  const output = new Writable({ write(chunk, _encoding, done) { size+=Buffer.byteLength(chunk); if(size>16384){done(new Error('SCOPE_PROBE_OUTPUT_LIMIT'));return;}chunks.push(Buffer.from(chunk));done(); } });
  let streamError: Error | undefined; output.on('error',e=>{streamError=e;});
  await run(output as unknown as http.ServerResponse);
  if(streamError || !output.writableEnded) throw new Error('SCOPE_PROBE_EXECUTION_INCOMPLETE');
  const lines=Buffer.concat(chunks).toString('utf8').trim().split('\n').map(l=>JSON.parse(l));
  const results=lines.filter(v=>v.type==='result'); const r=results[0]?.result;
  if(results.length!==1 || lines.some(v=>!['stdout','stderr','result'].includes(v.type)) || r?.execResult?.exit_code!==0
    || r.execResult.timed_out!==false || r.cancellation?.requested!==false || r.cancellation?.processGroupExited!==true
    || typeof r.execResult.stdout!=='string' || r.execResult.stderr!=='') throw new Error('SCOPE_PROBE_EXECUTION_FAILED');
  // No credentials are passed by this probe. executeRun returns only after its
  // normal cleanup finally; actual scratch cleanup is checked independently.
  return {exitCode:0,stdout:r.execResult.stdout,stderr:'',cleanupComplete:true,processGroupExited:true};
}
export function requireEmptyScopeProbeRequest(request: http.IncomingMessage): string {
  const owner=request.headers['x-tower-maintenance-owner'];
  if(typeof owner!=='string' || request.headers['transfer-encoding'] || request.headers.expect
    || (request.headers['content-length']!==undefined && request.headers['content-length']!=='0')
    || Object.keys(request.headers).some(k=>k.startsWith('x-tower-') && k!=='x-tower-maintenance-owner')) throw new Error('SCOPE_PROBE_REQUEST_INVALID');
  return owner;
}
export function createWorkerScopeExecutionProbe(options: ScopeProbeInstallation & {
  gate: WorkerMaintenanceGate;
  /** Installed code callback ONLY; shared server selects its actual execution mode. */
  execute: (input: {projectId:string;root:string;command:string;signal:AbortSignal}) => Promise<FixedExecutionResult>;
}) {
  let session: { c:ScopeProbeContext; scratch?:ScratchIdentity; stage:'preparing'|'prepared'|'verified'|'cleaned'|'failed'; uid?:number;gid?:number } | undefined;
  let running=false,pendingExecution=false;const consumed=new Set<string>();
  function context(owner:string){const c=readScopeProbeContext(options,owner);if(c.pid!==process.pid)throw new Error('SCOPE_PROBE_PID_MISMATCH');return c;}
  async function execute(stage:CommandStage, signal:AbortSignal) {
    const s=session!; equalContext(s.c,context(s.c.owner));
    if(signal.aborted)throw new Error('SCOPE_PROBE_CANCELLED');
    const leave=options.gate.enterProbe(s.c.owner);if(!leave)throw new Error('SCOPE_PROBE_NOT_OWNER');
    let r:FixedExecutionResult;
    pendingExecution=true;
    const execution=Promise.resolve().then(()=>options.execute({projectId:s.c.projectId,root:s.c.root,command:fixedScopeProbeCommand(s.c,stage,s.scratch),signal}))
      .finally(()=>{pendingExecution=false;leave();});
    let timer:ReturnType<typeof setTimeout>|undefined;
    try { r=await Promise.race([execution,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('SCOPE_PROBE_EXECUTION_TIMEOUT_UNVERIFIED')),16000);})]); }
    finally{if(timer)clearTimeout(timer);} // If executor ignores cancellation, real active count stays until it settles.
    if(signal.aborted || r.exitCode!==0 || r.stderr!=='' || r.cleanupComplete!==true || r.processGroupExited!==true || r.stdout.length>2048)throw new Error('SCOPE_PROBE_EXECUTION_FAILED');
    const p=JSON.parse(r.stdout);
    if(p.nonce!==s.c.nonce || p.stage!==stage || ![p.dev,p.ino,p.uid,p.gid].every(v=>Number.isSafeInteger(v)&&v>=0)
      || (s.scratch && (p.dev!==s.scratch.dev || p.ino!==s.scratch.ino)) || (s.uid!==undefined&&(p.uid!==s.uid||p.gid!==s.gid))) throw new Error('SCOPE_PROBE_EXECUTION_EVIDENCE_INVALID');
    s.scratch={dev:p.dev,ino:p.ino};s.uid=p.uid;s.gid=p.gid;equalContext(s.c,context(s.c.owner));
  }
  return {
    async handle(action:'prepare'|'verify'|'cleanup'|'abort',owner:string,signal:AbortSignal=AbortSignal.timeout(15000)) {
      if(running||pendingExecution)throw new Error('SCOPE_PROBE_BUSY');running=true;
      try {
        const c=context(owner);
        if(action==='prepare') {
          if(session || consumed.has(c.nonce) || consumed.size>=256 || options.gate.snapshot().activeRequests!==0)throw new Error('SCOPE_PROBE_BUSY');
          if(!options.gate.owns(owner))throw new Error('SCOPE_PROBE_NOT_OWNER');
          consumed.add(c.nonce);session={c,stage:'preparing'};
          await execute('prepare',signal);session.stage='prepared';
        } else {
          if(!session&&action==='abort'){
            try{fs.lstatSync(path.join(c.root,scopeProbeDirectory(c)));throw new Error('SCOPE_PROBE_CLEANUP_REQUIRES_REVIEW');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
            return {...c,stage:'cleaned'};
          }
          if(!session)throw new Error('SCOPE_PROBE_SESSION_MISSING');equalContext(session.c,c);
          if(action==='verify') {
            if(session.stage!=='prepared')throw new Error('SCOPE_PROBE_STAGE_INVALID');await execute('verify',signal);session.stage='verified';
          } else {
            if(action==='cleanup'&&session.stage!=='verified')throw new Error('SCOPE_PROBE_STAGE_INVALID');
            // Unknown scratch identity after an interrupted prepare is not adopted.
            if(!session.scratch){
              if(action!=='abort')throw new Error('SCOPE_PROBE_CLEANUP_REQUIRES_REVIEW');
              try{fs.lstatSync(path.join(c.root,scopeProbeDirectory(c)));throw new Error('SCOPE_PROBE_CLEANUP_REQUIRES_REVIEW');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
              session=undefined;return {...c,stage:'cleaned'};
            }
            await execute(action==='abort'?'abort':'cleanup',signal);session.stage='cleaned';
          }
        }
        const result={...c,scratch:session.scratch,commandUid:session.uid,commandGid:session.gid,stage:session.stage};
        if(session.stage==='cleaned')session=undefined;
        return result;
      } catch(error) { if(session)session.stage='failed';throw error; }
      finally {running=false;}
    },
  };
}

export interface BackendProbePolicy {
  version:1; uid:number; gid:number; cgroup:string; entrypoint:string;
}
/** Called INSIDE the Backend process, never by a root controller impersonating it.
 * Root-protected installed policy + actual /proc identity/cgroup/immutable argv are
 * mandatory. A supplied UID number or HTTP bearer token alone is not authority. */
export function assertScopeBackendPeer(policyFile:string, expected:{pid:number;uid:number;gid:number;startTicks:string}) {
  assertRootProbeState(policyFile); const p=JSON.parse(fs.readFileSync(policyFile,'utf8')) as BackendProbePolicy;
  if(!Number.isSafeInteger(expected.pid)||expected.pid<=0)throw new Error('SCOPE_BACKEND_IDENTITY_UNPROVEN');
  const proc=`/proc/${expected.pid}`;
  const ticks=()=>{const stat=fs.readFileSync(`${proc}/stat`,'utf8');return stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];};
  const first=ticks();const status=fs.readFileSync(`${proc}/status`,'utf8');
  if(p.version!==1 || !Number.isSafeInteger(p.uid)||p.uid<=0||!Number.isSafeInteger(p.gid)||p.gid<=0 || expected.uid!==p.uid||expected.gid!==p.gid
    || !/^\/system\.slice\/[A-Za-z0-9_.@-]+\.service$/.test(p.cgroup)
    || !/^\/nix\/store\/[a-z0-9]{32}-[^/\s]+\/lib\/tower\/dist\/backend\/[A-Za-z0-9/_.-]+\.js$/.test(p.entrypoint)
    || !fs.readFileSync(`${proc}/cmdline`,'utf8').split('\0').includes(p.entrypoint)
    || !fs.readFileSync(`${proc}/cgroup`,'utf8').split('\n').includes(`0::${p.cgroup}`)
    || !['Uid','Gid'].every(key=> {
      const values=new RegExp(`^${key}:\\s+(.+)$`,'m').exec(status)?.[1].trim().split(/\s+/).map(Number);
      return values?.length===4&&values.every(n=>n===(key==='Uid'?p.uid:p.gid));
    }) || first!==expected.startTicks || ticks()!==first) throw new Error('SCOPE_BACKEND_IDENTITY_UNPROVEN');
}
/** Local HTTP response provenance: its listener must be held by the exact
 * installed Backend process, not merely return that process's public PID. */
export function assertScopeBackendListener(policyFile:string,url:string,identity:{pid:number;uid:number;gid:number;startTicks:string}) {
  assertScopeBackendPeer(policyFile,identity);
  const parsed=new URL(url);if(parsed.hostname!=='127.0.0.1'||parsed.protocol!=='http:')throw new Error('SCOPE_BACKEND_LISTENER_INVALID');
  assertScopeBackendSocketOwner(identity.pid,identity.uid,Number(parsed.port));
  assertScopeBackendPeer(policyFile,identity);
}
/** IPv4 loopback connection: exact 127.0.0.1 OR 0.0.0.0 listen socket. IPv6-only
 * installations are explicitly unsupported until dual-stack semantics are pinned. */
export function assertScopeBackendSocketOwner(pid:number,uid:number,port:number) {
  if(!Number.isSafeInteger(pid)||pid<=0||!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('SCOPE_BACKEND_LISTENER_INVALID');
  const address=`0100007F:${port.toString(16).toUpperCase().padStart(4,'0')}`;
  const listeners=fs.readFileSync(`/proc/${pid}/net/tcp`,'utf8').trim().split('\n').slice(1)
    .map(line=>line.trim().split(/\s+/)).filter(row=>[address,`00000000:${port.toString(16).toUpperCase().padStart(4,'0')}`].includes(row[1])&&row[3]==='0A'&&Number(row[7])===uid).map(row=>row[9]);
  const sockets=fs.readdirSync(`/proc/${pid}/fd`).flatMap(fd=>{try{return [fs.readlinkSync(`/proc/${pid}/fd/${fd}`)];}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}});
  if(!listeners.some(ino=>sockets.includes(`socket:[${ino}]`)))throw new Error('SCOPE_BACKEND_LISTENER_UNPROVEN');
}
export function assertScopeBackendIdentity(policyFile:string): {pid:number;uid:number;gid:number;startTicks:string} {
  const stat=fs.readFileSync('/proc/self/stat','utf8');
  const identity={pid:process.pid,uid:process.getuid?.()??-1,gid:process.getgid?.()??-1,startTicks:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]};
  assertScopeBackendPeer(policyFile,identity);return identity;
}
/** Local Backend listener glue (not installed). It must be mounted after its
 * operator-only authentication; actions/owner do not grant Backend identity. */
export function createBackendScopeSharedWriteProbe(options: ScopeProbeInstallation & {
  backendPolicyFile:string;
  /** Trusted test seam, never a request field. Production default checks /proc. */
  identity?:typeof assertScopeBackendIdentity;
}) {
  let session: {c:ScopeProbeContext;scratch:ScratchIdentity;identity:ReturnType<typeof assertScopeBackendIdentity>;stage:'exchanged'|'verified'|'failed'} | undefined;
  function current(owner:string) { const identity=(options.identity??assertScopeBackendIdentity)(options.backendPolicyFile);return {c:readScopeProbeContext(options,owner),identity}; }
  function directory(c:ScopeProbeContext,root:string) { const dir=path.join(root,scopeProbeDirectory(c));const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink())throw new Error('SCOPE_BACKEND_SCRATCH_INVALID');return {dir,scratch:{dev:st.dev,ino:st.ino}}; }
  function file(dir:string,name:string,write?:string,create=false) {
    const parent=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
    const parentStat=fs.fstatSync(parent);
    if(!session || parentStat.dev!==session.scratch.dev || parentStat.ino!==session.scratch.ino){fs.closeSync(parent);throw new Error('SCOPE_BACKEND_SCRATCH_REPLACED');}
    let fd:number;try{fd=fs.openSync(`/proc/self/fd/${parent}/${name}`,(write===undefined?fs.constants.O_RDONLY:fs.constants.O_RDWR)|(create?fs.constants.O_CREAT|fs.constants.O_EXCL:0)|fs.constants.O_NOFOLLOW,0o666);}catch(e){fs.closeSync(parent);throw e;}
    try{const st=fs.fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.size>1024)throw new Error('SCOPE_BACKEND_FILE_INVALID');
      if(write===undefined)return fs.readFileSync(fd,'utf8');fs.ftruncateSync(fd,0);fs.writeFileSync(fd,write);fs.fsyncSync(fd);return write;
    }finally{fs.closeSync(fd);fs.closeSync(parent);}
  }
  return {handle(action:'exchange'|'verify'|'cleaned'|'abort',owner:string) {
    const {c,identity}=current(owner);
    const rootfd=fs.openSync(c.root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
    const pinned=fs.fstatSync(rootfd);const root=`/proc/self/fd/${rootfd}`;
    try {
    if(pinned.dev!==c.rootIdentity.dev||pinned.ino!==c.rootIdentity.ino)throw new Error('SCOPE_BACKEND_ROOT_CHANGED');
    if(action==='abort') {
      if(session){equalContext(session.c,c);if(JSON.stringify(identity)!==JSON.stringify(session.identity))throw new Error('SCOPE_BACKEND_IDENTITY_CHANGED');}
      try{fs.lstatSync(path.join(root,scopeProbeDirectory(c)));throw new Error('SCOPE_BACKEND_NOT_CLEANED');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      session=undefined;return {...c,backend:identity,stage:'abort'};
    }
    if(action==='exchange') {
      if(session)throw new Error('SCOPE_BACKEND_PROBE_BUSY');
      const {dir,scratch}=directory(c,root);session={c,scratch,identity,stage:'exchanged'};
      if(file(dir,'shared')!==`worker:${c.operationDigest}`)throw new Error('SCOPE_BACKEND_READ_FAILED');
      file(dir,'shared',`backend:${c.operationDigest}`);file(dir,'backend',`backend:${c.operationDigest}`,true);
    } else {
      if(!session)throw new Error('SCOPE_BACKEND_SESSION_MISSING');equalContext(session.c,c);
      if(JSON.stringify(identity)!==JSON.stringify(session.identity))throw new Error('SCOPE_BACKEND_IDENTITY_CHANGED');
      if(action==='verify') {
        const {dir,scratch}=directory(c,root);if(JSON.stringify(scratch)!==JSON.stringify(session.scratch))throw new Error('SCOPE_BACKEND_SCRATCH_REPLACED');
        if(session.stage!=='exchanged'||file(dir,'worker-ack')!==`worker:${c.operationDigest}`||file(dir,'shared')!==`backend:${c.operationDigest}`)throw new Error('SCOPE_BACKEND_ACK_FAILED');
        file(dir,'backend-ack',`backend:${c.operationDigest}`,true);session.stage='verified';
      } else {
        if(session.stage!=='verified')throw new Error('SCOPE_BACKEND_STAGE_INVALID');
        try {fs.lstatSync(path.join(root,scopeProbeDirectory(c)));throw new Error('SCOPE_BACKEND_NOT_CLEANED');}
        catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      }
    }
    equalContext(c,current(owner).c);
    const receipt={...c,scratch:session!.scratch,backend:identity,stage:action};if(action==='cleaned')session=undefined;return receipt;
    }catch(e){if(session)session.stage='failed';throw e;}finally{fs.closeSync(rootfd);}
  }};
}

/** Coordinator client. Fixed installed URLs only; never follows redirects or sends
 * commands, paths, env, Project or nonce in request. Both peers independently read
 * the journal. Backend responses must be vouched for by installed endpoint auth. */
export function createScopeProjectExecutionClient(options: ScopeProbeInstallation & {
  workerUrl:string;backendUrl:string;workerToken:()=>Promise<string>;backendToken:()=>Promise<string>;
  /** Required existing control-plane authority for this exact Backend instance.
   * E.g. pinned local TLS/service identity; no self-asserted JSON trust fallback. */
  backendPolicyFile:string;
  /** Bootstrap test seam only. Production checks /proc identity AND listener inode. */
  verifyBackendPeer?:(evidence:{pid:number;uid:number;gid:number;startTicks:string})=>Promise<void>;
}) {
  for(const url of [options.workerUrl,options.backendUrl])if(!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(url))throw new Error('SCOPE_PROBE_NONLOCAL_ENDPOINT');
  return async(owner:string):Promise<ProjectExecutionReceipt>=>{
    const c=readScopeProbeContext(options,owner);let peerIdentity:string|undefined;
    const call=async(peer:'worker'|'backend',action:string)=>{
      const base=peer==='worker'?options.workerUrl:options.backendUrl;const token=await(peer==='worker'?options.workerToken():options.backendToken());
      if(!token)throw new Error('SCOPE_PROBE_AUTHORITY_MISSING');
      const response=await fetch(`${base}/v1/maintenance/${peer==='worker'?'project-execution':'backend-shared-write'}/${action}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'x-tower-maintenance-owner':owner},redirect:'error',signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new Error('SCOPE_PROBE_HTTP_FAILED');
      const reader=response.body?.getReader();if(!reader)throw new Error('SCOPE_PROBE_RESPONSE_MISSING');
      let text='',bytes=0;try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>8192)throw new Error('SCOPE_PROBE_RESPONSE_LIMIT');text+=Buffer.from(part.value).toString('utf8');}}finally{await reader.cancel();}
      const r=JSON.parse(text);
      if(r.stage!==(peer==='worker'?({prepare:'prepared',verify:'verified',cleanup:'cleaned',abort:'cleaned'} as Record<string,string>)[action]:action))throw new Error('SCOPE_PROBE_STAGE_MISMATCH');
      const keys=['owner','projectId','root','rootIdentity','workerId','pid','nonce','operationDigest','scopeDigest'] as const;
      for(const key of keys)if(JSON.stringify(r[key])!==JSON.stringify(c[key]))throw new Error('SCOPE_PROBE_RESPONSE_MISMATCH');
      if(peer==='backend') {
        if(!r.backend || ![r.backend.pid,r.backend.uid,r.backend.gid].every(n=>Number.isSafeInteger(n)&&n>0)||!/^\d+$/.test(r.backend.startTicks))throw new Error('SCOPE_PROBE_BACKEND_IDENTITY_INVALID');
        if(options.verifyBackendPeer)await options.verifyBackendPeer(r.backend);else assertScopeBackendListener(options.backendPolicyFile,options.backendUrl,r.backend);
        if(peerIdentity!==undefined&&peerIdentity!==JSON.stringify(r.backend))throw new Error('SCOPE_PROBE_BACKEND_CHANGED');peerIdentity=JSON.stringify(r.backend);
      }
      equalContext(c,readScopeProbeContext(options,owner));return r;
    };
    let attempted=false;
    try {
      attempted=true;const first=await call('worker','prepare');
      const backend=await call('backend','exchange');
      if(backend.backend.pid===c.pid || backend.backend.uid===first.commandUid)throw new Error('SCOPE_PROBE_BACKEND_NOT_SEPARATED');
      if(JSON.stringify(first.scratch)!==JSON.stringify(backend.scratch))throw new Error('SCOPE_PROBE_DIFFERENT_FILESYSTEM');
      await call('worker','verify');await call('backend','verify');await call('worker','cleanup');await call('backend','cleaned');
      return {owner:c.owner,projectId:c.projectId,rootDigest:digest(c.root),pid:c.pid,scopeDigest:c.scopeDigest,commandVerified:true,backendSharedWriteVerified:true,cleaned:true,nonce:c.nonce,operationDigest:c.operationDigest,rootIdentity:c.rootIdentity,backend:backend.backend,commandUid:first.commandUid};
    } catch(error) {
      // Best-effort narrow cleanup only. Failure is never converted to receipt;
      // prepared/failed peer state remains fenced for explicit inspection.
      if(attempted){try{await call('worker','abort');}catch{/* no cleanup claim */}
        try{await call('backend','abort');}catch{/* retained recovery condition */}}
      throw error;
    }
  };
}

/** Committed recovery is deliberately separate from prepare/nonce admission. The
 * journal and DB adapter prove exact persisted success, lifecycle proves live
 * PID/JTI/scope, and this read-only check proves unchanged root and scratch absence.
 */
export function verifyPersistedScopeProbe(installation:ScopeProbeInstallation,op:AssignmentOperation) {
  (installation.assertTrustedState??assertRootProbeState)(installation.stateFile);
  const state=JSON.parse(fs.readFileSync(installation.stateFile,'utf8'));
  if(state.owner!==op.id||!['binding-intent','binding-committed'].includes(state.operation?.phase)
    ||JSON.stringify(state.operation)!==JSON.stringify(op)||!op.executionReceipt)throw new Error('SCOPE_COMMITTED_PROBE_JOURNAL_MISMATCH');
  assertScopeExecutionBinding(op,op.executionReceipt);
  const root=installation.projects[op.projectId];const st=fs.lstatSync(root);
  if(root!==op.newScope[op.projectId]||fs.realpathSync(root)!==root||!st.isDirectory()||st.dev!==op.rootIdentity.dev||st.ino!==op.rootIdentity.ino)throw new Error('SCOPE_COMMITTED_PROBE_ROOT_CHANGED');
  const scratch=path.join(root,`.tower-scope-exec-${op.executionNonce}`);
  try{fs.lstatSync(scratch);throw new Error('SCOPE_COMMITTED_PROBE_NOT_CLEANED');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(fs.readdirSync(root).some(n=>n.startsWith('.tower-assignment-probe-')))throw new Error('SCOPE_COMMITTED_UPLOAD_NOT_CLEANED');
}
