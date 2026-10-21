import { createPrivateKey } from 'node:crypto';
import { z } from 'zod';
import { getPersistedWorkbenchWorker } from '../execution/worker/worker-repository.js';
import { getSecretForProjectBinding } from '../secret/secret-store.js';
import { resolveWorkbenchWorkerTransportToken } from '../execution/worker/worker-transport-credentials.js';
import { resolveProjectEnvironmentDeploymentId } from './project-environment-deployment.js';
const schema=z.object({workerId:z.string().regex(/^[A-Za-z0-9._-]{1,120}$/),deploymentId:z.string().min(1),
 baseUrl:z.string().url().refine(value=>{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&['127.0.0.1','[::1]'].includes(u.hostname)&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/';}),
 projectIds:z.array(z.string().min(1)).min(1).max(256),signingSecretName:z.string().min(1).max(128),}).strict();
/** Explicit bounded deployment selection, not a new file permission database.
 * Local endpoint alone does not prove mount or UID identity; installation must
 * verify those before opt-in. Selected unavailable targets never fall back.
 */
export async function resolveCanonicalWriteTarget(projectId:string,env:NodeJS.ProcessEnv=process.env) {
 const raw=env.TOWER_CANONICAL_WRITE_TARGET; if(raw===undefined)return undefined;
 let config:z.infer<typeof schema>;
 try {config=schema.parse(JSON.parse(raw));if(new Set(config.projectIds).size!==config.projectIds.length)throw new Error();}
 catch {throw new Error('CANONICAL_WRITE_CONFIG_INVALID');}
 if(!config.projectIds.includes(projectId))return undefined;
 const worker=await getPersistedWorkbenchWorker(config.workerId);
 if(config.deploymentId!==resolveProjectEnvironmentDeploymentId(env)||!worker||worker.deploymentId!==config.deploymentId||worker.status!=='healthy'||worker.baseUrl!==config.baseUrl)throw new Error('CANONICAL_WRITE_UNAVAILABLE');
 try {
  const secret=await resolveWorkbenchWorkerTransportToken(config.workerId,0);
  const key=await getSecretForProjectBinding(config.signingSecretName);
  if(!secret||!/^-----BEGIN PRIVATE KEY-----/.test(key))throw new Error();
  const signingKey=createPrivateKey(key);if(signingKey.asymmetricKeyType!=='ed25519')throw new Error();
  return {workerId:config.workerId,baseUrl:config.baseUrl,secret,signingKey};
 } catch {throw new Error('CANONICAL_WRITE_CREDENTIAL_UNAVAILABLE');}
}
