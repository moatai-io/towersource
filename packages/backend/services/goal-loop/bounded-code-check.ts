import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Server-approved manifest and argv only. Tests execute code with workstation
 * authority: this is not a sandbox or permission grant. Never expose raw argv as
 * model-controlled tool input. Caller must include tests/config/dependencies in
 * the approved manifest and serialize all relevant writers for receipt commit.
 */
export interface ApprovedCodeCheck {
  root: string; files: readonly string[]; executable: string; args: readonly string[];
  timeoutMs: number; maxOutputBytes: number;
}
export async function digestCodeManifest(root: string, files: readonly string[]): Promise<string> {
  const base=await fs.realpath(root);
  if(!files.length || files.length>500 || new Set(files).size!==files.length) throw new Error('INVALID_CHECK_MANIFEST');
  const hash=createHash('sha256'); let total=0;
  for(const relative of [...files].sort()) {
    if(path.isAbsolute(relative) || relative.split(/[\\/]/).some(p=>p==='..'||p==='') || /(^|[\\/])\.env(?:\.|$)/.test(relative)) throw new Error('INVALID_CHECK_PATH');
    const file=path.join(base,relative);
    const resolved=await fs.realpath(file);
    if(resolved!==file || !resolved.startsWith(base+path.sep)) throw new Error('CHECK_SYMLINK_REJECTED');
    const stat=await fs.stat(file);
    if(!stat.isFile() || stat.size>10_000_000 || (total+=stat.size)>50_000_000) throw new Error('CHECK_MANIFEST_TOO_LARGE');
    const bytes=await fs.readFile(file);
    hash.update(JSON.stringify([relative,bytes.length]));hash.update(bytes);
  }
  return hash.digest('hex');
}
export async function runApprovedCodeCheck(input:ApprovedCodeCheck, signal:AbortSignal) {
  const spec={...input,files:[...input.files],args:[...input.args]};
  if(!Number.isInteger(spec.timeoutMs)||spec.timeoutMs<1||spec.timeoutMs>120000
    || !Number.isInteger(spec.maxOutputBytes)||spec.maxOutputBytes<1||spec.maxOutputBytes>1_000_000) throw new Error('INVALID_CHECK_BUDGET');
  if(signal.aborted) return {status:'inconclusive' as const,reason:'cancelled'};
  const before=await digestCodeManifest(spec.root,spec.files);
  const execution=await new Promise<{ok:boolean;reason:string}>(resolve=>{
    const child=spawn(spec.executable,spec.args,{cwd:spec.root,shell:false,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
    let reason='';let output=0;let closed=false;
    const kill=()=>{if(child.pid){try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{ /* already gone */ }}};
    const stop=(why:string)=>{if(!reason)reason=why;kill();};
    const abort=()=>stop('cancelled');
    const timer=setTimeout(()=>stop('timeout'),spec.timeoutMs);
    const finish=(ok:boolean,why:string)=>{if(closed)return;closed=true;clearTimeout(timer);signal.removeEventListener('abort',abort);resolve({ok,reason:why});};
    for(const stream of [child.stdout,child.stderr]) stream?.on('data',(chunk:Buffer)=>{output+=chunk.length;if(output>spec.maxOutputBytes)stop('output_limit');});
    child.on('error',()=>finish(false,'spawn_failed'));
    child.on('close',code=>{kill();finish(code===0&&!reason,reason||(code===0?'passed':'test_failed'));});
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  });
  let after:string;
  try{after=await digestCodeManifest(spec.root,spec.files);}catch{return {status:'inconclusive' as const,reason:'artifact_unavailable'};}
  if(signal.aborted || before!==after) return {status:'inconclusive' as const,reason:signal.aborted?'cancelled':'artifact_changed'};
  return {status:execution.ok?'passed' as const:execution.reason==='test_failed'?'failed' as const:'inconclusive' as const,
    reason:execution.reason,artifactDigest:after};
}
