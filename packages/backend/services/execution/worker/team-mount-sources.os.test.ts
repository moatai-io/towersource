/** Opt-in disposable Linux namespace; no registered Project or live Worker touched.
 * Run: TEAM_MOUNT_SOURCES_OS_TEST=1 npx vitest run <this file>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueWorkbenchProjectExecutionGrant } from '../../runtime-box/workbench-project-execution-grant.js';
import type { RemoteWorkbenchJobSpec } from '../remote-job-runner.js';
import { pinTeamMountSources } from './team-mount-sources.js';
let root: string;
let pinned: ReturnType<typeof pinTeamMountSources> | undefined;
const connected = `/connected/${createHash('sha256').update('b-files').digest('hex')}`;
describe.skipIf(process.env.TEAM_MOUNT_SOURCES_OS_TEST !== '1' || process.platform !== 'linux')('pinned team sources consumed by real bwrap', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-fd-mount-'));
    for (const name of ['a', 'b', 'outside']) fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, 'a', 'original'), 'own-original');
    fs.writeFileSync(path.join(root, 'b', 'original'), 'team-original');
    fs.writeFileSync(path.join(root, 'outside', 'sentinel'), 'synthetic-external-secret');
    const mounts = ['a', 'b'].map(owner => ({ workspaceId: `${owner}-files`, ownerProjectId: owner, source: path.join(root, owner), target: owner === 'a' ? '/workspace' : connected, readOnly: owner === 'b' }));
    const registeredSources = mounts.map(mount => {
      const stat = fs.statSync(mount.source, { bigint: true });
      return { workspaceId: mount.workspaceId, ownerProjectId: mount.ownerProjectId, source: mount.source, device: String(stat.dev), inode: String(stat.ino) };
    });
    const spec = { jobId: 'synthetic-os', projectId: 'a', actorUserId: 1, command: 'true', workbenchRevision: 'synthetic', environmentKeys: [] } as RemoteWorkbenchJobSpec;
    const secret = 'synthetic-test-signing-key';
    const grant = issueWorkbenchProjectExecutionGrant({ secret, workerId: 'worker-a', projectRoot: mounts[0].source, spec, teamScope: { teamId: 'team-a', mounts } });
    pinned = pinTeamMountSources({ verification: { grant, secret, workerId: 'worker-a', spec }, registeredSources });
  });
  afterEach(() => { pinned?.close(); pinned = undefined; fs.rmSync(root, { recursive: true, force: true }); });
  function execute(script: string, firstChildFd = 6) {
    const binding = pinned!.bwrapBindings(firstChildFd);
    // Assert capability rather than quietly falling back to path binds.
    const help = spawnSync('/usr/bin/bwrap', ['--help'], { encoding: 'utf8' });
    expect(help.stdout).toContain('--bind-fd FD DEST');
    expect(help.stdout).toContain('--ro-bind-fd FD DEST');
    return spawnSync('/usr/bin/bwrap', [
      '--die-with-parent', '--new-session', '--unshare-all', '--clearenv',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--setenv', 'PATH', '/usr/bin:/bin',
      '--dir', '/connected', ...binding.args, '--chdir', '/workspace', '/bin/sh', '-c', script,
    ], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' }, stdio: binding.stdio });
  }
  it('consumes mapped O_PATH handles after roots become external symlinks; preserves rw/ro and closes child handles', () => {
    for (const name of ['a', 'b']) {
      fs.renameSync(path.join(root, name), path.join(root, `original-${name}`));
      fs.symlinkSync(path.join(root, 'outside'), path.join(root, name));
    }
    const result = execute(`set -eu
      test "$(cat /workspace/original)" = own-original
      test "$(cat ${connected}/original)" = team-original
      test ! -e /workspace/sentinel
      test ! -e ${connected}/sentinel
      printf changed > /workspace/new-file
      if printf denied > ${connected}/new-file; then exit 41; fi
      test ! -e /proc/self/fd/6
      test ! -e /proc/self/fd/7
    `);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(root, 'original-a', 'new-file'), 'utf8')).toBe('changed');
    expect(fs.existsSync(path.join(root, 'original-b', 'new-file'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'outside', 'new-file'))).toBe(false);
  });
  it('binds the pinned old root after replacement by an ordinary directory at the signed path', () => {
    fs.renameSync(path.join(root, 'b'), path.join(root, 'original-b'));
    fs.mkdirSync(path.join(root, 'b'));
    fs.writeFileSync(path.join(root, 'b', 'sentinel'), 'replacement-not-authorized');
    const result = execute(`set -eu; test "$(cat ${connected}/original)" = team-original; test ! -e ${connected}/sentinel`, 3);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
});
