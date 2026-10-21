import path from 'node:path';
import { randomUUID, type KeyObject } from 'node:crypto';
import { signWorkstationLaunch } from './workstation-launch-authorization.js';
import { executeWorkstationLaunch } from './workstation-launch-transport.js';
/** Declared installation mapping; not proof of OS peer identity. */
export interface InstalledExecutorMapping {
  projectId: string; projectRoot: string; home: string;
  controllerUid: number; launcherUid: number; commandUid: number; commandGid: number;
}
export interface ExecutorResult { exitCode: number; stdout: string; stderr: string; cleanupComplete: true; processGroupExited: true; }
export interface WorkstationExecutorCapability {
  mapping: InstalledExecutorMapping;
  execute(input: { command: string; timeoutSec: number; credentials: Record<string, string>; signal: AbortSignal }): Promise<ExecutorResult>;
}
export function validateExecutorCapability(capability: WorkstationExecutorCapability, projectId: string, root: string) {
  const m = capability?.mapping;
  const validPath = (p: unknown): p is string => typeof p === 'string' && path.isAbsolute(p) && p !== '/' && path.normalize(p) === p && !/[\0\r\n]/.test(p);
  if (!m || typeof capability.execute !== 'function' || typeof m.projectId !== 'string' || !m.projectId
    || !validPath(m.home) || !validPath(m.projectRoot)) throw new Error('EXECUTOR_MAPPING_INVALID');
  if (m.projectId !== projectId || m.projectRoot !== root) throw new Error('EXECUTOR_MAPPING_MISMATCH');
  const ids = [m.controllerUid, m.launcherUid, m.commandUid, m.commandGid];
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0 || id >= 0xffffffff)
    || new Set([m.controllerUid,m.launcherUid,m.commandUid]).size !== 3) throw new Error('EXECUTOR_IDENTITY_INVALID');
}
export function validateExecutorResult(value: unknown, credentials: Record<string,string>): ExecutorResult {
  const r = value as ExecutorResult;
  if (!r || typeof r !== 'object' || !Number.isInteger(r.exitCode) || r.exitCode < 0 || r.exitCode > 255
    || typeof r.stdout !== 'string' || typeof r.stderr !== 'string'
    || Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr) > 1024 * 1024) throw new Error('EXECUTOR_RESULT_INVALID');
  if (r.cleanupComplete !== true || r.processGroupExited !== true) throw new Error('EXECUTOR_CLEANUP_INCOMPLETE');
  // Raw output is never exposed if any credential was supplied. Envelope decoding
  // cannot reliably enumerate derived OAuth/file secrets; fail conservatively.
  const redact = Object.keys(credentials).length > 0;
  return { exitCode: r.exitCode, cleanupComplete: true, processGroupExited: true, stdout: redact ? '[credential-bearing execution output withheld]' : r.stdout, stderr: redact ? '' : r.stderr };
}
export function createSignedWorkstationExecutor(input: { mapping: InstalledExecutorMapping; socketPath: string; instanceId: string; privateKey: KeyObject }): WorkstationExecutorCapability {
  const mapping = Object.freeze({ ...input.mapping });
  const { socketPath, instanceId, privateKey } = input;
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || path.normalize(socketPath)!==socketPath || /[\0\r\n]/.test(socketPath)
    || typeof instanceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(instanceId)
    || !privateKey || privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new Error('EXECUTOR_BOOTSTRAP_INVALID');
  const capability: WorkstationExecutorCapability = {
    mapping,
    async execute(request) {
      const signed = signWorkstationLaunch({ version: 1, projectId: mapping.projectId, instanceId,
        requestId: randomUUID(), issuedAt: Date.now(), expiresAt: Date.now()+30000,
        payload: JSON.stringify({ command: request.command, cwd: '.', timeoutSec: request.timeoutSec, credentials: request.credentials }) }, privateKey);
      return validateExecutorResult(await executeWorkstationLaunch(socketPath, signed, request.signal, (request.timeoutSec+5)*1000), request.credentials);
    },
  };
  validateExecutorCapability(capability, mapping.projectId, mapping.projectRoot);
  return Object.freeze(capability);
}
