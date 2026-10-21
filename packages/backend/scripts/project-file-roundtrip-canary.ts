/** Operator-only explicit canary. No server route, token minting, binding mutation or fallback. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runFileRoundtripCanary } from '../services/project-environment/file-roundtrip-canary.js';

export async function main() {
  const [originArg, projectId, sessionId, workerId, confirmation] = process.argv.slice(2);
  const token = process.env.TOWER_CANARY_USER_TOKEN;
  const blocked = (reason: string) => { console.log(JSON.stringify({status:'BLOCKED', reason, scope:'execution-file-api'})); process.exitCode = 2; };
  if (!originArg || !projectId || !sessionId || !workerId || confirmation !== '--approved-scratch-write' || !token) return blocked('EXPLICIT_INPUT_AND_USER_AUTH_REQUIRED');
  const origin = new URL(originArg);
  if (!['127.0.0.1','localhost','[::1]'].includes(origin.hostname) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || !(origin.protocol === 'https:' || (origin.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(origin.hostname)))) return blocked('INVALID_ORIGIN');
  const get = async (url: string) => {
    const response = await fetch(url, { headers: {Authorization:`Bearer ${token}`}, redirect:'error', signal:AbortSignal.timeout(15000), cache:'no-store' });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return response.json();
  };
  // An existing user token is required; never impersonate a user or read signing keys.
  const me = await get(new URL('/api/me',origin).href);
  const userId = Number(me.id ?? me.userId);
  if (!Number.isSafeInteger(userId) || userId < 1) return blocked('USER_ID_UNAVAILABLE');
  const apiSession = await get(new URL(`/api/sessions/${encodeURIComponent(sessionId)}`,origin).href);
  if (apiSession.id !== sessionId || apiSession.projectId !== projectId) return blocked('API_SESSION_MISMATCH');
  const { queryOne } = await import('../db/pg-repo.js');
  const session = await queryOne<{ project_id: string; user_id: number }>('SELECT project_id,user_id FROM sessions WHERE id=$1',[sessionId]);
  if (!session || session.project_id !== projectId || Number(session.user_id) !== userId) return blocked('OWNED_SESSION_REQUIRED');
  const { resolveProjectExecutionContext } = await import('../services/project-environment/project-execution-context.js');
  const { resolveProjectEnvironmentDeploymentId } = await import('../services/project-environment/project-environment-deployment.js');
  const { requireCurrentAgentExecutionAccess } = await import('../services/authority/agent-execution-access.js');
  const { selectProjectExecutionProvider } = await import('../services/execution/executor-selector.js');
  const { executeWorkbenchRequest } = await import('../services/execution/execution-broker.js');
  const deploymentId = resolveProjectEnvironmentDeploymentId();
  const admit = () => resolveProjectExecutionContext({projectId,actorUserId:userId,sessionId,deploymentId,requiredCapabilities:['exec']});
  const admitted = await admit();
  if (admitted.environmentMode !== 'canonical-project-workspace' || admitted.preferredExecutorId !== workerId) return blocked('EXPECTED_CANONICAL_WORKER_REQUIRED');
  // Preflight HTTP ACL before scratch writes. The API itself authorizes this caller.
  await get(new URL(`/api/files/tree?path=${encodeURIComponent(admitted.projectRoot)}`,origin).href);
  const report = await runFileRoundtripCanary({
    execute: async command => {
      const current = await admit();
      if (current.projectRoot !== admitted.projectRoot || current.preferredExecutorId !== workerId || current.environmentMode !== admitted.environmentMode) throw new Error('AUTHORITY_CHANGED');
      const access = await requireCurrentAgentExecutionAccess({projectId,userId});
      const request = {command,workdir:'.',timeoutSec:30};
      const provider = await selectProjectExecutionProvider({request,projectId,projectRoot:current.projectRoot,actorUserId:userId,sessionId,deploymentId,executionContext:current,defaultWorkerId:workerId});
      if (provider.kind !== 'remote-worker') throw new Error('UNEXPECTED_EXECUTOR');
      const result = await executeWorkbenchRequest({request,context:{projectId,userId,sessionId,...access},provider});
      if (result.execution.lifecycle !== 'foreground') throw new Error('UNEXPECTED_LIFECYCLE');
      return {exitCode:result.execution.result.exit_code,stdout:result.execution.result.stdout};
    },
    read: async relativePath => {
      const url = new URL('/api/files/read',origin);
      url.searchParams.set('path',path.join(admitted.projectRoot,relativePath));
      const result = await get(url.href);
      if (typeof result.content !== 'string' || result.storageAuthority !== 'host') throw new Error('UNEXPECTED_FILE_RESPONSE');
      return result.content;
    },
  });
  console.log(JSON.stringify(report));
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.log(JSON.stringify({status:'BLOCKED',reason:'PREFLIGHT_OR_AUTH_FAILED'})); process.exitCode=2; });
}
