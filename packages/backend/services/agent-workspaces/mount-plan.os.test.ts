/** Opt-in real Linux mount enforcement. No running Worker or registered folders touched. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planAgentWorkspaceMounts, type WorkspaceMountCandidate } from './mount-plan.js';
let root: string;
let source: string;
function execute(readOnly: boolean) {
  const candidate: WorkspaceMountCandidate = { workspaceId: 'linked-files', locator: { kind: 'host', root: source }, facts: {
    user_role: 'member', user_disabled: 0, agent_archived: 0, agent_status: 'active', membership_role: 'member', workspace_state: 'active',
    owner_project_id: 'b', owner_root_path: source, owner_archived: 0, workspace_kind: 'project', grant_mode: readOnly ? 'read' : 'read-write', grant_version: 1, grant_revoked_at: null,
  } };
  const [mount] = planAgentWorkspaceMounts({ agentProjectId: 'a', candidates: [candidate], projectRoots: [{ projectId: 'b', root: source }] });
  const args = ['--die-with-parent', '--new-session', '--unshare-all', '--clearenv',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--setenv', 'PATH', '/usr/bin:/bin',
    '--bind', path.join(root, 'own'), '/workspace', '--dir', '/connected',
    mount.readOnly ? '--ro-bind' : '--bind', mount.source, mount.target,
    '--chdir', '/workspace', '/bin/sh', '-c',
    'set -eu; cat "$1/existing"; printf own > /workspace/own-write; test ! -e "$2"; test ! -e "$1/escape/secret"; printf changed > "$1/existing"; printf created > "$1/new"; mv "$1/new" "$1/renamed"; rm "$1/renamed"',
    'fixture', mount.target, path.join(root, 'unconnected', 'secret')];
  return spawnSync('/usr/bin/bwrap', args, { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
}
describe.skipIf(process.env.AGENT_WORKSPACE_MOUNT_TEST !== '1' || process.platform !== 'linux')('planned mounts enforced by bwrap', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mount-'));
    source = path.join(root, 'linked');
    for (const dir of ['own', 'linked', 'unconnected']) fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(source, 'existing'), 'original');
    fs.writeFileSync(path.join(root, 'unconnected', 'secret'), 'synthetic');
    fs.symlinkSync(path.join(root, 'unconnected'), path.join(source, 'escape'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  it('reads linked bytes but rejects an overwrite while own storage stays writable', () => {
    const result = execute(true);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe('original');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Read-only file system/);
    expect(fs.readFileSync(path.join(source, 'existing'), 'utf8')).toBe('original');
    expect(fs.readFileSync(path.join(root, 'own', 'own-write'), 'utf8')).toBe('own');
  });
  it('permits ordinary file mutations only on the read-write connection', () => {
    const result = execute(false);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(source, 'existing'), 'utf8')).toBe('changed');
    expect(fs.existsSync(path.join(source, 'renamed'))).toBe(false);
  });
});
