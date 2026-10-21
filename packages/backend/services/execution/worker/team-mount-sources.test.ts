import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { issueWorkbenchProjectExecutionGrant, type WorkbenchTeamExecutionMount } from '../../runtime-box/workbench-project-execution-grant.js';
import type { RemoteWorkbenchJobSpec } from '../remote-job-runner.js';
import { pinTeamMountSources, type RegisteredTeamMountSourceIdentity } from './team-mount-sources.js';

let root: string;
let mounts: WorkbenchTeamExecutionMount[];
let registeredSources: RegisteredTeamMountSourceIdentity[];
const spec = { jobId: 'synthetic-job', projectId: 'a', actorUserId: 1, command: 'true', workbenchRevision: 'synthetic', environmentKeys: [] } as RemoteWorkbenchJobSpec;
const secret = 'synthetic-test-signing-key';
function verification(scope = mounts) {
  const grant = issueWorkbenchProjectExecutionGrant({ secret, workerId: 'worker-a', projectRoot: mounts[0].source, spec, teamScope: { teamId: 'team-a', mounts: scope } });
  return { grant, secret, workerId: 'worker-a', spec };
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-pin-'));
  for (const name of ['a', 'b']) fs.mkdirSync(path.join(root, name));
  mounts = ['a', 'b'].map(owner => ({ workspaceId: `${owner}-files`, ownerProjectId: owner, source: path.join(root, owner),
    target: owner === 'a' ? '/workspace' : `/connected/${createHash('sha256').update(`${owner}-files`).digest('hex')}`, readOnly: owner === 'b' }));
  registeredSources = mounts.map(mount => {
    const stat = fs.statSync(mount.source, { bigint: true });
    return { workspaceId: mount.workspaceId, ownerProjectId: mount.ownerProjectId, source: mount.source, device: String(stat.dev), inode: String(stat.ino) };
  });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
it('verifies the signed scope and pins original directory identities without mutating registry', () => {
  const before = structuredClone(registeredSources);
  const pinned = pinTeamMountSources({ verification: verification(), registeredSources });
  try {
    expect(pinned.sources).toHaveLength(2);
    for (const source of pinned.sources) expect(String(fs.fstatSync(source.fd, { bigint: true }).ino)).toBe(source.inode);
    expect(registeredSources).toEqual(before);
  } finally { pinned.close(); }
});
it('rejects a forged signature before any source descriptor is opened', () => {
  const opened = vi.spyOn(fs, 'openSync');
  expect(() => pinTeamMountSources({ verification: { ...verification(), secret: 'incorrect-synthetic-key' }, registeredSources })).toThrow('signature');
  expect(opened).not.toHaveBeenCalled();
});
it('requires a signed team scope, not unsigned request mounts', () => {
  const grant = issueWorkbenchProjectExecutionGrant({ secret, workerId: 'worker-a', projectRoot: mounts[0].source, spec });
  expect(() => pinTeamMountSources({ verification: { ...verification(), grant }, registeredSources })).toThrow('TEAM_MOUNT_SIGNED_SCOPE_REQUIRED');
});
it.each(['missing', 'owner', 'path', 'device', 'inode', 'duplicate', 'malformed'] as const)('rejects registry %s mismatch independently of signed paths', change => {
  if (change === 'missing') registeredSources.pop();
  if (change === 'owner') registeredSources[1].ownerProjectId = 'outside';
  if (change === 'path') registeredSources[1].source = path.join(root, 'outside');
  if (change === 'device') registeredSources[1].device = '99999999999';
  if (change === 'inode') registeredSources[1].inode = '99999999999';
  if (change === 'duplicate') registeredSources.push({ ...registeredSources[1] });
  if (change === 'malformed') registeredSources[1].inode = '1.5';
  expect(() => pinTeamMountSources({ verification: verification(), registeredSources })).toThrow(/TEAM_MOUNT_(REGISTRY_INVALID|IDENTITY_MISMATCH)/);
});
it('rejects root symlinks rather than following them', () => {
  fs.renameSync(mounts[1].source, path.join(root, 'original-b'));
  fs.symlinkSync(path.join(root, 'original-b'), mounts[1].source);
  expect(() => pinTeamMountSources({ verification: verification(), registeredSources })).toThrow();
});
it('rejects an ancestor symlink, even when it resolves to the registered inode', () => {
  fs.mkdirSync(path.join(root, 'real-parent'));
  fs.renameSync(mounts[1].source, path.join(root, 'real-parent', 'b'));
  fs.symlinkSync(path.join(root, 'real-parent'), path.join(root, 'alias-parent'));
  mounts[1].source = path.join(root, 'alias-parent', 'b');
  registeredSources[1].source = mounts[1].source;
  expect(() => pinTeamMountSources({ verification: verification(), registeredSources })).toThrow();
});
it('rejects replacement directories with a different identity at the same signed root', () => {
  fs.renameSync(mounts[1].source, path.join(root, 'original-b'));
  fs.mkdirSync(mounts[1].source);
  expect(() => pinTeamMountSources({ verification: verification(), registeredSources })).toThrow('TEAM_MOUNT_IDENTITY_MISMATCH');
});
it('rejects regular files as roots', () => {
  fs.rmdirSync(mounts[1].source); fs.writeFileSync(mounts[1].source, 'synthetic');
  expect(() => pinTeamMountSources({ verification: verification(), registeredSources })).toThrow();
});
it('rejects duplicate device/inode aliases across different signed roots', () => {
  const original = fs.fstatSync.bind(fs);
  const aliasInode = registeredSources[1].inode;
  vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, options: any) => {
    const stat = original(fd, options) as fs.BigIntStats;
    if (String(stat.ino) === aliasInode) return { ...stat, dev: BigInt(registeredSources[0].device), ino: BigInt(registeredSources[0].inode), isDirectory: () => true };
    return stat;
  }) as typeof fs.fstatSync);
  registeredSources[1] = { ...registeredSources[1], device: registeredSources[0].device, inode: registeredSources[0].inode };
  expect(() => pinTeamMountSources({ verification: verification(), registeredSources })).toThrow('TEAM_MOUNT_INODE_ALIAS');
});
it('closes every opened descriptor when a later source fails', () => {
  const originalOpen = fs.openSync.bind(fs); const originalClose = fs.closeSync.bind(fs);
  const active = new Set<number>();
  vi.spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => { const fd = originalOpen(...args); active.add(fd); return fd; }) as typeof fs.openSync);
  vi.spyOn(fs, 'closeSync').mockImplementation(fd => { originalClose(fd); active.delete(fd); });
  registeredSources[1].inode = '99999999999';
  expect(() => pinTeamMountSources({ verification: verification(), registeredSources })).toThrow('TEAM_MOUNT_IDENTITY_MISMATCH');
  expect(active.size).toBe(0);
});
it('closes pinned handles once and refuses mapping after close', () => {
  const pinned = pinTeamMountSources({ verification: verification(), registeredSources });
  const fds = pinned.sources.map(source => source.fd);
  pinned.close(); pinned.close();
  for (const fd of fds) expect(() => fs.fstatSync(fd)).toThrow();
  expect(() => pinned.bwrapBindings()).toThrow('TEAM_MOUNT_SOURCES_CLOSED');
});
it('maps parent descriptors to explicitly numbered child stdio slots, never source paths', () => {
  const pinned = pinTeamMountSources({ verification: verification(), registeredSources });
  try {
    const binding = pinned.bwrapBindings(6);
    expect(binding.args).toEqual(['--bind-fd', '6', '/workspace', '--ro-bind-fd', '7', mounts[1].target]);
    expect(binding.stdio).toEqual(['pipe', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', ...pinned.sources.map(source => source.fd)]);
    for (const invalid of [0, 2, 3.5, 100000]) expect(() => pinned.bwrapBindings(invalid)).toThrow('TEAM_MOUNT_CHILD_FD_INVALID');
  } finally { pinned.close(); }
});
it('closes previously pinned sources and all traversal descriptors on ancestor open failure', () => {
  fs.renameSync(mounts[1].source, path.join(root, 'original-b'));
  fs.symlinkSync(path.join(root, 'original-b'), mounts[1].source);
  const originalOpen = fs.openSync.bind(fs); const originalClose = fs.closeSync.bind(fs);
  const active = new Set<number>();
  vi.spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => { const fd = originalOpen(...args); active.add(fd); return fd; }) as typeof fs.openSync);
  vi.spyOn(fs, 'closeSync').mockImplementation(fd => { originalClose(fd); active.delete(fd); });
  expect(() => pinTeamMountSources({ verification: verification(), registeredSources })).toThrow();
  expect(active.size).toBe(0);
});
it.each(['expired', 'worker', 'command'] as const)('rejects %s execution binding before opening source handles', change => {
  const verified = verification();
  const opened = vi.spyOn(fs, 'openSync');
  const modified = { ...verified, ...(change === 'expired' ? { now: new Date(Date.now() + 120_000) }
    : change === 'worker' ? { workerId: 'other-worker' } : { spec: { ...spec, command: 'changed' } }) };
  expect(() => pinTeamMountSources({ verification: modified, registeredSources })).toThrow();
  expect(opened).not.toHaveBeenCalled();
});
it('does not close unrelated parent descriptors when the pin owner closes', () => {
  const unrelated = fs.openSync(path.join(root, 'a'), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    const pinned = pinTeamMountSources({ verification: verification(), registeredSources });
    pinned.close();
    expect(fs.fstatSync(unrelated).isDirectory()).toBe(true);
  } finally { fs.closeSync(unrelated); }
});
