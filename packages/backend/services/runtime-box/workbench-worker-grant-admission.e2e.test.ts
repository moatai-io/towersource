import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRemoteWorkbenchWorkerServer } from '../execution/worker/worker-server.js';
import { issueWorkbenchAuthorizationReceipt } from './workbench-authorization-receipt.js';
import { issueWorkbenchProjectExecutionGrant } from './workbench-project-execution-grant.js';

const token = 'synthetic-grant-admission-token';
const workerId = 'synthetic-worker';
const spec = { jobId: 1, projectId: 'project-a', actorUserId: 7,
  sessionId: '11111111-1111-4111-8111-111111111111', command: 'printf executed > marker',
  cwd: '/workspace', timeoutSec: 10, workbenchRevision: null, environmentKeys: [] };
let parent: string;
let root: string;
let server: http.Server;
let baseUrl: string;
const execute = vi.fn(async () => ({ exitCode: 0, stdout: 'executed', stderr: '', cleanupComplete: true as const, processGroupExited: true as const }));
async function start(installed = false) {
  server = createRemoteWorkbenchWorkerServer({ workerId, token, projects: { 'project-a': root }, projectsRoot: parent,
    ...(installed ? { executionBackend: 'installed-executor' as const, executorCapabilities: new Map([['project-a', {
      mapping: { projectId: 'project-a', projectRoot: root, home: root, controllerUid: 1, launcherUid: 2, commandUid: 3, commandGid: 3 }, execute,
    }]]) } : {}),
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}
const grant = (extra = {}) => issueWorkbenchProjectExecutionGrant({ secret: token, workerId, projectRoot: root, spec, ...extra });
const teamGrant = () => grant({ teamScope: { teamId: 'team-a', mounts: [{ workspaceId: 'a-files',
  ownerProjectId: spec.projectId, source: root, target: '/workspace', readOnly: false }] } });
async function post(extra: Record<string, unknown> = {}, currentSpec = spec) {
  const authorizationReceipt = issueWorkbenchAuthorizationReceipt({ secret: token, actorUserId: currentSpec.actorUserId,
    projectId: currentSpec.projectId, sessionId: currentSpec.sessionId, jobId: currentSpec.jobId, environmentKeys: currentSpec.environmentKeys });
  const response = await fetch(`${baseUrl}/v1/runs`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ spec: currentSpec, authorizationReceipt, ...extra }) });
  return { status: response.status, text: await response.text() };
}
beforeEach(async () => { execute.mockClear(); parent = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-grant-admission-'));
  root = path.join(parent, 'project-a'); await fs.mkdir(root); });
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await fs.rm(parent, { recursive: true, force: true }); });
it.each([false, true])('rejects a signed team grant on an allowlisted Project before executor dispatch (installed=%s)', async installed => {
  await start(installed);
  expect((await post({ executionGrant: teamGrant() })).text).toContain('TEAM_EXECUTION_SCOPE_UNSUPPORTED');
  expect(execute).not.toHaveBeenCalled();
  await expect(fs.stat(path.join(root, 'marker'))).rejects.toThrow();
});
it('preserves no-grant allowlisted legacy execution', async () => {
  await start();
  expect((await post()).text).toContain('"type":"result"');
  expect(await fs.readFile(path.join(root, 'marker'), 'utf8')).toBe('executed');
});
it('accepts a matching signed legacy grant on an allowlisted Project', async () => {
  await start();
  expect((await post({ executionGrant: grant() })).text).toContain('"type":"result"');
  expect(await fs.readFile(path.join(root, 'marker'), 'utf8')).toBe('executed');
});
it('rejects a legacy grant root mismatch before native execution', async () => {
  await start(); const other = path.join(parent, 'other'); await fs.mkdir(other);
  expect((await post({ executionGrant: grant({ projectRoot: other }) })).text).toContain('execution grant Project root mismatch');
  await expect(fs.stat(path.join(root, 'marker'))).rejects.toThrow();
});
it('rechecks actual registered root identity rather than lexical path alone', async () => {
  const alias = path.join(parent, 'alias'); await fs.symlink(root, alias);
  await start();
  expect((await post({ executionGrant: grant({ projectRoot: alias }) })).text).toContain('execution grant Project root mismatch');
  await expect(fs.stat(path.join(root, 'marker'))).rejects.toThrow();
});
it('rejects a registered root replaced by a symlink even when the signed lexical root matches', async () => {
  const originalRoot = root;
  const moved = path.join(parent, 'moved'); await fs.rename(root, moved); await fs.symlink(moved, originalRoot);
  await start();
  expect((await post({ executionGrant: grant() })).text).toContain('execution grant Project root mismatch');
  await expect(fs.stat(path.join(moved, 'marker'))).rejects.toThrow();
});
it('rejects expired/tampered grants before installed dispatch', async () => {
  await start(true);
  const expired = grant({ now: new Date(Date.now() - 120_000) });
  expect((await post({ executionGrant: expired })).text).toContain('expired');
  const valid = grant(); const [payload, signature] = valid.split('.');
  const tampered = `${payload}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
  expect((await post({ executionGrant: tampered })).text).toContain('signature');
  expect(execute).not.toHaveBeenCalled();
});
it('rejects unsigned scope before native dispatch without writing a marker', async () => {
  await start();
  expect((await post({ teamScope: {} })).text).toContain('TEAM_EXECUTION_SCOPE_UNSIGNED');
  expect((await post({}, { ...spec, mounts: [] } as any)).text).toContain('TEAM_EXECUTION_SCOPE_UNSIGNED');
  await expect(fs.stat(path.join(root, 'marker'))).rejects.toThrow();
});
it('rejects a replayed grant even with a fresh authorization receipt', async () => {
  await start(true); const executionGrant = grant();
  expect((await post({ executionGrant })).text).toContain('"type":"result"');
  expect((await post({ executionGrant })).text).toContain('execution grant was already consumed');
  expect(execute).toHaveBeenCalledTimes(1);
});
it.each(['malformed', 7, null])('rejects an explicitly provided invalid grant instead of ignoring it (%s)', async executionGrant => {
  await start(true);
  expect((await post({ executionGrant })).text).toContain('"type":"error"');
  expect(execute).not.toHaveBeenCalled();
});
it('rejects a changed command or Worker in a provided legacy grant before dispatch', async () => {
  await start(true);
  expect((await post({ executionGrant: grant({ workerId: 'different' }) })).text).toContain('Worker mismatch');
  expect((await post({ executionGrant: grant({ spec: { ...spec, command: 'different' } }) })).text).toContain('request mismatch');
  expect(execute).not.toHaveBeenCalled();
});
it.each(['teamScope', 'teamScopeDigest', 'mounts', 'teamId', 'teamMountContext'])('rejects unsigned body/spec authority field %s before installed dispatch', async key => {
  await start(true);
  expect((await post({ [key]: {} })).text).toContain('TEAM_EXECUTION_SCOPE_UNSIGNED');
  expect((await post({}, { ...spec, [key]: {} })).text).toContain('TEAM_EXECUTION_SCOPE_UNSIGNED');
  expect(execute).not.toHaveBeenCalled();
});
