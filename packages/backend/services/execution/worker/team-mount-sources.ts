import fs from 'node:fs';
import type { StdioOptions } from 'node:child_process';
import { linuxPathDirectoryFlags } from '../../project-environment/adapters/linux-path-descriptor.js';
import { verifyWorkbenchProjectExecutionGrant } from '../../runtime-box/workbench-project-execution-grant.js';

/** Trusted Worker-side registry snapshot, loaded independently of the request or
 * signed path list. Identity must have been established from registered storage
 * by a trusted resolver, not stat(request.source) immediately before calling.
 * Decimal strings preserve dev/ino precision across JSON boundaries. Not bearer
 * authority: freshness, team membership and full registry guards remain required.
 */
export interface RegisteredTeamMountSourceIdentity {
  workspaceId: string;
  ownerProjectId: string;
  source: string;
  device: string;
  inode: string;
}
type GrantVerification = Omit<Parameters<typeof verifyWorkbenchProjectExecutionGrant>[0], 'allowTeamScope'>;

function openPinnedDirectory(root: string): number {
  const flags = linuxPathDirectoryFlags();
  let directory = fs.openSync('/', flags);
  try {
    for (const part of root.split('/').filter(Boolean)) {
      // Each ancestor is opened relative to the held directory, without following
      // symlinks. Keeping only the leaf FD is sufficient to pin its object identity.
      const next = fs.openSync(`/proc/self/fd/${directory}/${part}`, flags);
      try { fs.closeSync(directory); }
      catch (error) { fs.closeSync(next); throw error; }
      directory = next;
    }
    return directory;
  } catch (error) {
    fs.closeSync(directory);
    throw error;
  }
}

/** Internal prerequisite ONLY, not executor activation or permission admission.
 * Verifies the execution signature/binding itself, then pins signed source roots
 * against independent registered identities. Never accepts unsigned mounts.
 * Linux only. Requires bwrap --bind-fd/--ro-bind-fd support (confirmed on installed
 * bubblewrap 0.6.1); those are directory FD binds, unlike --bind-data file copies.
 * Caller retains these handles until bwrap has consumed child stdio descriptors,
 * and must close on launch error, abort or completion. No raw path fallback.
 * Does NOT address submounts, hard links, .tower/control/secret exposure, team
 * revocation or native-process isolation. Those remain activation blockers.
 */
export function pinTeamMountSources(input: {
  verification: GrantVerification;
  registeredSources: readonly RegisteredTeamMountSourceIdentity[];
}) {
  const claims = verifyWorkbenchProjectExecutionGrant({ ...input.verification, allowTeamScope: true });
  if (!claims.teamScope) throw new Error('TEAM_MOUNT_SIGNED_SCOPE_REQUIRED');
  const registered = new Map<string, RegisteredTeamMountSourceIdentity>();
  for (const source of input.registeredSources) {
    if (!source.workspaceId || !source.ownerProjectId || typeof source.device !== 'string' || typeof source.inode !== 'string'
      || !/^(0|[1-9][0-9]*)$/.test(source.device) || !/^[1-9][0-9]*$/.test(source.inode) || registered.has(source.workspaceId)) {
      throw new Error('TEAM_MOUNT_REGISTRY_INVALID');
    }
    registered.set(source.workspaceId, source);
  }
  const sources: Readonly<RegisteredTeamMountSourceIdentity & { target: string; readOnly: boolean; fd: number }>[] = [];
  const open = new Set<number>();
  const identities = new Set<string>();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    let failure: unknown;
    for (const fd of open) {
      try { fs.closeSync(fd); } catch (error) { failure ??= error; }
    }
    open.clear();
    if (failure) throw failure;
  };
  try {
    for (const mount of claims.teamScope.mounts) {
      const source = registered.get(mount.workspaceId);
      if (!source || source.ownerProjectId !== mount.ownerProjectId || source.source !== mount.source) throw new Error('TEAM_MOUNT_REGISTRY_INVALID');
      const fd = openPinnedDirectory(mount.source);
      open.add(fd);
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isDirectory() || String(stat.dev) !== source.device || String(stat.ino) !== source.inode) throw new Error('TEAM_MOUNT_IDENTITY_MISMATCH');
      const identity = `${source.device}:${source.inode}`;
      if (identities.has(identity)) throw new Error('TEAM_MOUNT_INODE_ALIAS');
      identities.add(identity);
      sources.push(Object.freeze({ ...source, target: mount.target, readOnly: mount.readOnly, fd }));
    }
  } catch (error) {
    // Preserve the actionable original failure while attempting every fd cleanup.
    try { close(); } catch { /* all handles were attempted */ }
    throw error;
  }
  return Object.freeze({
    sources: Object.freeze(sources),
    close,
    /** Slot 0..2 reserved for stdio. A caller with other inherited handles must
     * select non-overlapping child slots and merge only those earlier slots.
     * Node duplicates each parent FD into the numbered child slot; bwrap consumes
     * those child numbers, never /proc/self/fd paths interpreted after namespace
     * setup. Keep owner handles alive through spawn; do not leak to native jobs.
     */
    bwrapBindings(firstChildFd = 3): { args: string[]; stdio: StdioOptions } {
      if (closed) throw new Error('TEAM_MOUNT_SOURCES_CLOSED');
      if (!Number.isSafeInteger(firstChildFd) || firstChildFd < 3 || firstChildFd + sources.length > 1024) throw new Error('TEAM_MOUNT_CHILD_FD_INVALID');
      const stdio: StdioOptions = ['pipe', 'pipe', 'pipe'];
      while (stdio.length < firstChildFd) stdio.push('ignore');
      const args: string[] = [];
      sources.forEach((source, index) => {
        stdio.push(source.fd);
        args.push(source.readOnly ? '--ro-bind-fd' : '--bind-fd', String(firstChildFd + index), source.target);
      });
      return { args, stdio };
    },
  });
}
