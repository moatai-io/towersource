/** Temporal change evidence, NEVER file ownership. Host Git worktrees only. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
async function git(cwd: string, args: string[]) {
  return (await exec('git', args, { cwd, timeout: 10000, maxBuffer: 8 * 1024 * 1024 })).stdout;
}
export async function snapshotGitFiles(root: string): Promise<Map<string, string>> {
  const names = (await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean);
  if (names.length > 20000) throw new Error('snapshot_file_limit');
  const snapshot = new Map<string, string>();
  let bytes = 0;
  for (const name of new Set(names)) {
    if (name.split('/').some(p => p === '..') || path.isAbsolute(name)) continue;
    if (/(^|\/)(\.env[^/]*|credentials?[^/]*|secrets?[^/]*|node_modules|dist|\.git)(\/|$)|\.(pem|key|p12|pfx)$/i.test(name)) continue;
    const file = path.join(root, name);
    const stat = await fs.lstat(file).catch((e: any) => { if (e.code === 'ENOENT') return null; throw e; });
    if (!stat?.isFile()) continue;
    if (stat.size > 5 * 1024 * 1024) throw new Error('snapshot_file_size_limit');
    bytes += stat.size;
    if (bytes > 128 * 1024 * 1024) throw new Error('snapshot_total_size_limit');
    // Do not follow directory symlinks outside the repository.
    if (!(await fs.realpath(file)).startsWith(root + path.sep)) continue;
    snapshot.set(name, `${stat.mode}:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`);
  }
  return snapshot;
}
export function changedGitFiles(before: Map<string, string>, after: Map<string, string>) {
  return [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p) !== after.get(p));
}
export function wrapBashChangeObserver<T extends { execute?: (...args: any[]) => any }>(tool: T, ctx: { cwd: string; sessionId: string }): T {
  const original = tool.execute!;
  return { ...tool, execute: async (...args: any[]) => {
    let root: string | undefined, ledger: string | undefined, before: Map<string, string> | undefined;
    const startedAt = new Date().toISOString();
    try {
      root = await fs.realpath((await git(ctx.cwd, ['rev-parse', '--show-toplevel'])).trim());
      ledger = path.resolve(root, (await git(root, ['rev-parse', '--git-common-dir'])).trim(), 'tower-bash-observations.jsonl');
      before = await snapshotGitFiles(root);
    } catch { console.warn('[bash-change-observer] before snapshot unavailable; no ownership inferred'); }
    try { return await original.apply(tool, args); }
    finally {
      if (root && ledger) {
        try {
          const after = before ? await snapshotGitFiles(root) : undefined;
          const record = { version: 1, sessionId: ctx.sessionId, toolCallId: String(args[0]), startedAt, finishedAt: new Date().toISOString(), root, evidence: 'temporal-candidate', complete: !!before && !!after, paths: before && after ? changedGitFiles(before, after) : [] };
          await fs.appendFile(ledger, JSON.stringify(record) + '\n', { mode: 0o600 });
        } catch { console.warn('[bash-change-observer] observation unavailable; command result preserved'); }
      }
    }
  } };
}
