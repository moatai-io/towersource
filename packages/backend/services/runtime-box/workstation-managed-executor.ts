/** General foreground orchestration over an installed OS service manager.
 * No root RPC, sudo, or subprocess fallback. The trusted adapter must enforce fixed
 * project account and cgroup ownership (KillMode=control-group, Delegate=no).
 * Never treat setsid/killpg as proof that an entire service is empty.
 */
import { randomUUID } from 'node:crypto';
import { validateExecutorCapability, type InstalledExecutorMapping, type WorkstationExecutorCapability, type ExecutorResult } from './workstation-executor-capability.js';
export interface ManagedRunSpec {
  runId: string; mapping: Readonly<InstalledExecutorMapping>; command: string; timeoutSec: number;
  env: Readonly<Record<string,string>>;
}
export interface ManagedServiceHandle {
  completed: Promise<{ exitCode: number; stdout: string; stderr: string }>;
}
export interface WorkstationServiceManager {
  /** Must check live installed mapping/manager capabilities; declared config is insufficient. */
  probe(mapping: Readonly<InstalledExecutorMapping>): Promise<{ identityVerified: boolean; cgroupOwnership: boolean }>;
  /** If start throws after partial creation, stopAndVerify(runId) still owns that run. */
  start(spec: ManagedRunSpec): Promise<ManagedServiceHandle>;
  /** Idempotent, including absent/start-in-flight run. Tombstone prevents late start. */
  stopAndVerify(runId: string): Promise<{ empty: boolean }>;
}
export interface ManagedCredentialLease {
  env: Record<string,string>;
  /** Materializer enumerates actual secret values incl. decoded file/provider payloads. */
  redaction: { exhaustive: boolean; values: string[] };
  cleanup(): Promise<void>;
}
export function createManagedWorkstationExecutor(input: {
  mapping: InstalledExecutorMapping; manager: WorkstationServiceManager;
  /** Owns rollback on prepare rejection; runId journal must support restart recovery. */
  prepare(runId: string, credentials: Record<string,string>, mapping: Readonly<InstalledExecutorMapping>): Promise<ManagedCredentialLease>;
  /** Abort-unresponsive OS adapters cause failure, never fallback/success. */
  operationDeadlineMs?: number;
}): WorkstationExecutorCapability {
  const mapping = Object.freeze({...input.mapping});
  const { manager, prepare } = input;
  const limit = input.operationDeadlineMs ?? 5000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 60000) throw new Error('EXECUTOR_BOOTSTRAP_INVALID');
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([promise, new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('EXECUTOR_OPERATION_TIMEOUT')),limit);})]); }
    finally { clearTimeout(timer!); }
  };
  const capability: WorkstationExecutorCapability = { mapping, async execute(request) {
    if (typeof request.command!=='string' || !request.command || request.command.length>65536
      || !Number.isInteger(request.timeoutSec) || request.timeoutSec<1 || request.timeoutSec>3600) throw new Error('EXECUTOR_REQUEST_UNSUPPORTED');
    const live = await bounded(manager.probe(mapping));
    if (live.identityVerified!==true || live.cgroupOwnership!==true) throw new Error('EXECUTOR_CAPABILITY_UNAVAILABLE');
    if(request.signal.aborted)throw new Error('EXECUTOR_CANCELLED');
    const runId=randomUUID();
    // prepare is deliberately awaited: abandoning in-flight materialization would
    // orphan secrets. Its implementation MUST enforce a deadline and rollback.
    let lease: ManagedCredentialLease;
    try {lease=await prepare(runId,{...request.credentials},mapping);}catch{throw new Error('EXECUTOR_PREPARATION_FAILED');}
    let value: Awaited<ManagedServiceHandle['completed']> | undefined;
    let failure=''; let stopped=false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort!: (e: Error)=>void;
    const interrupted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
    void interrupted.catch(()=>{});
    const cancel=()=>rejectAbort(new Error('EXECUTOR_CANCELLED'));
    request.signal.addEventListener('abort',cancel,{once:true});
    try {
      if(request.signal.aborted)throw new Error('EXECUTOR_CANCELLED');
      timer=setTimeout(()=>rejectAbort(new Error('EXECUTOR_TIMEOUT')),request.timeoutSec*1000);
      const handle=await Promise.race([bounded(manager.start({runId,mapping,command:request.command,timeoutSec:request.timeoutSec,env:Object.freeze({...lease.env})})),interrupted]);
      value=await Promise.race([handle.completed,interrupted]);
    }catch(error){failure=error instanceof Error && ['EXECUTOR_CANCELLED','EXECUTOR_TIMEOUT'].includes(error.message)?error.message:'EXECUTOR_EXECUTION_FAILED';}
    finally {clearTimeout(timer);request.signal.removeEventListener('abort',cancel);}
    try {stopped=(await bounded(manager.stopAndVerify(runId))).empty===true;}catch{}
    // Never delete a secret file still used by a live/unverified run. Retain lease
    // for manager recovery and report it explicitly instead of claiming cleanup.
    if(!stopped)throw new Error('EXECUTOR_TERMINATION_UNVERIFIED_CREDENTIALS_RETAINED');
    const redaction = { exhaustive: lease.redaction.exhaustive, values: [...lease.redaction.values] };
    try {await lease.cleanup();}catch{throw new Error('EXECUTOR_CLEANUP_INCOMPLETE');}
    if(failure)throw new Error(failure);
    if(!value || !Number.isInteger(value.exitCode)||value.exitCode<0||value.exitCode>255
      || typeof value.stdout!=='string'||typeof value.stderr!=='string'||Buffer.byteLength(value.stdout)+Buffer.byteLength(value.stderr)>1048576)throw new Error('EXECUTOR_RESULT_INVALID');
    const redact=(text:string)=>{
      if(!redaction.exhaustive)return Object.keys(request.credentials).length?'[credential-bearing execution output withheld]':text;
      return [...redaction.values].filter(Boolean).sort((a,b)=>b.length-a.length).reduce((out,secret)=>out.split(secret).join('[REDACTED]'),text);
    };
    const result: ExecutorResult={exitCode:value.exitCode,stdout:redact(value.stdout),stderr:redact(value.stderr),cleanupComplete:true,processGroupExited:true};
    return result;
  }};
  validateExecutorCapability(capability,mapping.projectId,mapping.projectRoot);
  return Object.freeze(capability);
}
