import { projectWorkspaceEntryExists } from '../services/project-environment/project-workspace-files.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, stat } from 'node:fs/promises';
import path from 'node:path';
vi.mock('../services/pm/project-access.js', async importOriginal => ({
  ...await importOriginal<any>(),
  isPathAccessible: vi.fn(async () => true),
  isPathWritableByRole: vi.fn(async () => true),
}));
// The production tool delegates Project files to the Worker storage authority.
// Exercise its orchestration against a local filesystem adapter in this unit test.
vi.mock('../services/project-environment/project-workspace-files.js', () => ({
  resolveProjectWorkspaceFile: vi.fn(async ({ projectId, projectRoot, relativePath }: any) => ({ projectId, projectRoot, relativePath, hostPath: path.join(projectRoot, relativePath) })),
  projectWorkspaceEntryExists: vi.fn(async ({ reference }: any) => ({ exists: await import('node:fs/promises').then(fs => fs.stat(reference.hostPath).then(() => true, () => false)) })),
  readProjectWorkspaceFileBytes: vi.fn(async ({ reference }: any) => ({ bytes: await import('node:fs/promises').then(fs => fs.readFile(reference.hostPath)) })),
  createProjectWorkspaceDirectory: vi.fn(async ({ reference }: any) => { await import('node:fs/promises').then(fs => fs.mkdir(reference.hostPath, { recursive: true })); return 'worker'; }),
  writeProjectWorkspaceText: vi.fn(async ({ reference, content, exclusive }: any) => { await import('node:fs/promises').then(fs => fs.writeFile(reference.hostPath, content, { flag: exclusive ? 'wx' : 'w' })); return 'worker'; }),
  compareAndSwapProjectWorkspaceText: vi.fn(async ({ reference, expectedContent, content }: any) => {
    const fs = await import('node:fs/promises');
    if (await fs.readFile(reference.hostPath, 'utf8') !== expectedContent) throw new Error('version_conflict');
    await fs.writeFile(reference.hostPath, content);
    return 'worker';
  }),
}));
import { createMarkdownArtifactTool } from './pi-markdown-artifact-tool.js';
import { isPathAccessible, isPathWritableByRole } from '../services/pm/project-access.js';
import { extractTextFromContent } from '../utils/text.js';
const dirs: string[] = [];
afterEach(async () => { vi.clearAllMocks(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'markdown-tool-')); dirs.push(cwd);
  const tool = createMarkdownArtifactTool({ cwd, projectId: 'p', projectRoot: cwd, userId: 7, userRole: 'member' });
  return { cwd, run: (args: any) => tool.execute('call-1', args) };
}
const args = { path: 'work/report.md', title: 'Report', body: '# Report\n\nUnique body' };
describe('Markdown delivery tool', () => {
  it('saves once, returns only a receipt, and accepts identical retries', async () => {
    const { cwd, run } = await setup();
    const first: any = await run(args); const retry: any = await run(args);
    expect(first.isError).toBe(false); expect(retry).toEqual(first);
    expect(await readFile(path.join(cwd, args.path), 'utf8')).toBe(args.body + '\n');
    expect(first.content[0].text).not.toContain('Unique body');
    expect(JSON.parse(first.content[0].text)).toMatchObject({ ok: true, action: 'present_file', artifact: 'markdown', focus: true });
  });
  it('accepts project-specific folders and authorized explicit absolute destinations', async () => {
    const { cwd, run } = await setup();
    expect((await run({ ...args, path: 'knowledge/runbooks/report.md' }) as any).isError).toBe(false);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'markdown-authorized-')); dirs.push(outside);
    const destination = path.join(outside, 'report.md');
    expect((await run({ ...args, path: destination }) as any).isError).toBe(false);
    expect(await readFile(destination, 'utf8')).toBe(args.body + '\n');
  });
  it('does not overwrite existing different content', async () => {
    const { cwd, run } = await setup(); await run(args);
    expect((await run({ ...args, body: 'changed' }) as any).isError).toBe(true);
    expect(await readFile(path.join(cwd, args.path), 'utf8')).toBe(args.body + '\n');
  });
  it('rejects unsafe paths, denied writes, and symlink escapes', async () => {
    const { cwd, run } = await setup();
    for (const p of ['../oops.md', 'work/../oops.md', 'work/report.txt', 'C:\\oops.md']) expect((await run({ ...args, path: p }) as any).isError).toBe(true);
    vi.mocked(isPathWritableByRole).mockResolvedValueOnce(false);
    expect((await run(args) as any).isError).toBe(true);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'markdown-outside-')); dirs.push(outside);
    await symlink(outside, path.join(cwd, 'work'));
    vi.mocked(isPathAccessible).mockImplementationOnce(async () => false);
    expect((await run(args) as any).isError).toBe(true);
  });
  it('includes authored body in transcript extraction without requiring a second message', () => {
    expect(extractTextFromContent(JSON.stringify([{ type: 'tool_use', name: 'create_markdown_artifact', input: args }]))).toBe(args.body);
  });
});

describe('Markdown revisions', () => {
  it('reads the exact hash, updates in place, refuses stale versions, accepts identical retry', async () => {
    const { cwd, run } = await setup(); await run(args);
    const ctx = { cwd, projectId: 'p', projectRoot: cwd, userId: 7, userRole: 'member' };
    const read = createMarkdownArtifactTool(ctx, 'read');
    const update = createMarkdownArtifactTool(ctx, 'update');
    const initial: any = await read.execute('read', { path: args.path });
    const snapshot = JSON.parse(initial.content[0].text);
    expect(snapshot.body).toBe(args.body + '\n');
    const revision = { ...args, body: '# Revised', expectedSha256: snapshot.sha256 };
    const saved: any = await update.execute('update', revision);
    expect(JSON.parse(saved.content[0].text)).toMatchObject({ ok: true, operation: 'update', action: 'present_file', focus: false });
    expect((await update.execute('retry', revision) as any).isError).toBe(false);
    const conflict: any = await update.execute('stale', { ...revision, body: '# Stale' });
    expect(JSON.parse(conflict.content[0].text).code).toBe('version_conflict');
    expect(await readFile(path.join(cwd, args.path), 'utf8')).toBe('# Revised\n');
  });
});

const aclSupported = process.platform === 'linux' && spawnSync('setfacl', ['--version']).status === 0;
describe.skipIf(!aclSupported)('Markdown artifact ACL inheritance', () => {
  it('retains peer write on nested creation and revision without widening a private revision', async () => {
    const { cwd, run } = await setup();
    const peer = process.getuid!() === 65534 ? 65533 : 65534;
    execFileSync('setfacl', ['-m', `u:${peer}:rwx,d:u:${peer}:rwx,d:m::rwx,d:o::---`, cwd]);
    const target = path.join(cwd, args.path);
    const peerCanWrite = () => {
      const lines = execFileSync('getfacl', ['-cpn', target], { encoding: 'utf8' }).split('\n');
      return lines.find(line => line.startsWith(`user:${peer}:`))?.split(':')[2].includes('w')
        && lines.find(line => line.startsWith('mask::'))?.split(':')[2].includes('w');
    };
    expect((await run(args) as any).isError).toBe(false);
    expect(peerCanWrite()).toBe(true);
    const ctx = { cwd, projectId: 'p', projectRoot: cwd, userId: 7, userRole: 'member' };
    const read = createMarkdownArtifactTool(ctx, 'read');
    const update = createMarkdownArtifactTool(ctx, 'update');
    const snapshot = JSON.parse((await read.execute('read', { path: args.path }) as any).content[0].text);
    expect((await update.execute('update', { ...args, body: 'second', expectedSha256: snapshot.sha256 }) as any).isError).toBe(false);
    expect(peerCanWrite()).toBe(true);
    await chmod(target, 0o600);
    const privateSnapshot = JSON.parse((await read.execute('read', { path: args.path }) as any).content[0].text);
    expect((await update.execute('private-update', { ...args, body: 'private', expectedSha256: privateSnapshot.sha256 }) as any).isError).toBe(false);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(peerCanWrite()).toBe(false);
  });
});


describe('Markdown bounded failure receipts', () => {
  it.each(['ENOENT', 'EACCES', 'EPERM', 'WORKER_FILE_AUTHORITY_SCOPE_MISMATCH'])('returns a short AI receipt without raw stderr for %s', async code => {
    const { run } = await setup();
    vi.mocked(projectWorkspaceEntryExists).mockRejectedValueOnce(new Error(`node:fs stack\nError: ${code}: secret diagnostic path\n at hidden.internal.js:42`));
    const result: any = await run(args);
    const receipt = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(receipt.ok).toBe(false);
    expect(typeof receipt.code).toBe('string');
    expect(receipt.recoverable).toBe(code === 'ENOENT');
    expect(receipt.suggestedAction).toBe(code === 'ENOENT' ? 'check_parent_and_retry' : 'request_authorized_access');
    expect(receipt.userMessage).toBeTruthy();
    expect(result.content[0].text).not.toMatch(/node:fs|secret diagnostic|hidden.internal/);
    expect(receipt.error).toBeUndefined();
  });
});

describe('private Markdown artifacts', () => {
  it('denies private create and update before writing project content', async () => {
    const { cwd: root } = await setup();
    const privacy = await import('../services/session/session-artifact-privacy.js');
    const denied = vi.spyOn(privacy, 'assertSessionAllowsSharedArtifactWrite').mockRejectedValue(Object.assign(new Error('Private session content cannot be saved automatically'), { code: 'private_shared_storage_denied' }));
    try {
      for (const mode of ['create', 'update'] as const) {
        const tool = createMarkdownArtifactTool({ cwd: root, projectRoot: root, projectId: 'p', userId: 1, sessionId: 'private' }, mode);
        const result: any = await tool.execute('t', { path: 'work/private.md', body: '# Secret' });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain('private_shared_storage_denied');
      }
      await expect(readFile(path.join(root, 'work/private.md'))).rejects.toThrow();
      expect(denied).toHaveBeenCalledWith('private');
    } finally { denied.mockRestore(); }
  });
});
