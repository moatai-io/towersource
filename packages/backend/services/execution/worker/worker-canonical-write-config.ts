import fs from 'node:fs';
import path from 'node:path';
import { loadCanonicalWritePublicKey } from '../../runtime-box/canonical-write-public-key.js';
import { createCanonicalWriteReplayStore } from '../../runtime-box/canonical-write-replay-store.js';
import { createCanonicalWriteRecheckClient } from '../../runtime-box/canonical-write-recheck-client.js';
import type { CanonicalFileWriteAuthority } from '../../runtime-box/canonical-file-write-http.js';
export interface WorkerCanonicalWriteConfig { backendUrl: string; verificationKeyFile: string; replayRoot: string }
/** Installation-only composition. No key generation, directory creation, DB or Vault.
 * Config/key ownership and native-process isolation must be enforced by deployment.
 */
export function buildWorkerCanonicalWriteAuthority(config: WorkerCanonicalWriteConfig | undefined, writableRoots: string[], workerIdentityToken?: string): CanonicalFileWriteAuthority | undefined {
 if (!config) return undefined;
 if (!workerIdentityToken?.trim()) throw new Error('CANONICAL_WRITE_WORKER_IDENTITY_REQUIRED');
 const paths = [config.verificationKeyFile, config.replayRoot];
 for (const value of paths) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || fs.realpathSync(value) !== value || fs.lstatSync(value).isSymbolicLink()) throw new Error('CANONICAL_WRITE_RUNTIME_PATH_UNTRUSTED');
 }
 const contains = (a: string,b: string) => a===b || b.startsWith(a+path.sep);
 for (const root of writableRoots.map(r => fs.realpathSync(r))) {
  if (contains(root,config.verificationKeyFile) || contains(root,config.replayRoot) || contains(config.replayRoot,root)) throw new Error('CANONICAL_WRITE_RUNTIME_PROJECT_OVERLAP');
 }
 const verificationKey = loadCanonicalWritePublicKey(config.verificationKeyFile)!;
 return { verificationKey,
  authorize: createCanonicalWriteRecheckClient({ backendUrl:config.backendUrl, workerIdentityToken }),
  consume: createCanonicalWriteReplayStore(config.replayRoot),
 };
}
