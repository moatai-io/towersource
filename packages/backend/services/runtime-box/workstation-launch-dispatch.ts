/** Prototype dispatch boundary. No socket listener or production routing is enabled.
 * Installed identity and verifier must be supplied by trusted bootstrap, never requests.
 */
import { z } from 'zod';
import { validateWorkstationCommandIdentity, type WorkstationCommandIdentity, type LauncherProcessIdentity } from './workstation-command-identity.js';
import type { LaunchEnvelope } from './workstation-launch-authorization.js';
const payloadSchema = z.object({
  command: z.string().min(1).max(65536),
  cwd: z.literal('.'), // Until safe filesystem resolution is integrated, project root only.
  timeoutSec: z.number().int().min(1).max(3600),
  credentials: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.string().max(262144)),
}).strict();
export type LaunchPayload = z.infer<typeof payloadSchema>;
export function createWorkstationLaunchDispatcher<T>(deps: {
  policy: WorkstationCommandIdentity;
  controllerUid: number;
  identity: () => LauncherProcessIdentity;
  verify: (request: { wire: string; signature: string }) => LaunchEnvelope;
  prepare: (credentials: Record<string, string>) => Promise<{ cleanup: () => Promise<void>; env: Record<string, string> }>;
  run: (input: { command: string; cwd: string; home: string; env: Record<string, string>; timeoutSec: number; signal: AbortSignal }) => Promise<T>;
}) {
  return async (request: { wire: string; signature: string }, signal: AbortSignal): Promise<T> => {
    const envelope = deps.verify(request);
    validateWorkstationCommandIdentity(deps.policy, { projectId: envelope.projectId, controllerUid: deps.controllerUid, launcher: deps.identity() });
    let payload: LaunchPayload;
    try { payload = payloadSchema.parse(JSON.parse(envelope.payload)); }
    catch { throw new Error('LAUNCH_PAYLOAD_INVALID'); } // Never serialize Zod errors containing credentials.
    if (Object.keys(payload.credentials).length > 64) throw new Error('LAUNCH_CREDENTIAL_LIMIT');
    if (signal.aborted) throw new Error('LAUNCH_CANCELLED');
    // prepare owns rollback if it fails before returning its handle.
    let prepared: Awaited<ReturnType<typeof deps.prepare>>;
    try { prepared = await deps.prepare(payload.credentials); }
    catch { throw new Error('LAUNCH_PREPARATION_FAILED'); }
    let result: T | undefined;
    let executionFailed = false;
    let executionError: unknown;
    try {
      if (signal.aborted) throw new Error('LAUNCH_CANCELLED');
      result = await deps.run({ command: payload.command, cwd: deps.policy.projectRoot, home: deps.policy.home,
        env: prepared.env, timeoutSec: payload.timeoutSec, signal });
    } catch (error) {
      executionFailed = true;
      executionError = error;
    }
    try { await prepared.cleanup(); }
    catch {
      // Do not attach arbitrary adapter errors: they may contain command/env secrets.
      throw new Error(executionFailed ? 'LAUNCH_EXECUTION_AND_CLEANUP_FAILED' : 'LAUNCH_CLEANUP_FAILED');
    }
    if (executionFailed) {
      if (signal.aborted || (executionError instanceof Error && executionError.message === 'LAUNCH_CANCELLED')) {
        throw new Error('LAUNCH_CANCELLED');
      }
      throw new Error('LAUNCH_EXECUTION_FAILED');
    }
    return result as T;
  };
}
