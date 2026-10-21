import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryOneMock = vi.fn();
const workspaceMocks = vi.hoisted(() => ({
  resolve: vi.fn(), exists: vi.fn(), read: vi.fn(), write: vi.fn(), mkdir: vi.fn(), cas: vi.fn(), writable: vi.fn(async () => true),
}));

vi.mock('../../db/pg-repo.js', () => ({ queryOne: (...args: any[]) => queryOneMock(...args) }));
vi.mock('../pm/project-access.js', () => ({ isPathWritableByRole: workspaceMocks.writable }));
vi.mock('../project-environment/project-workspace-files.js', () => ({
  resolveProjectWorkspaceFile: workspaceMocks.resolve,
  projectWorkspaceEntryExists: workspaceMocks.exists,
  readProjectWorkspaceFileBytes: workspaceMocks.read,
  writeProjectWorkspaceText: workspaceMocks.write,
  createProjectWorkspaceDirectory: workspaceMocks.mkdir,
  compareAndSwapProjectWorkspaceText: workspaceMocks.cas,
}));

const { normalizeAssistantArtifactBlocks, materializeAssistantArtifactBlocks } = await import('./assistant-artifact-blocks.js');

describe('assistant artifact blocks', () => {
  let root = '';
  const oldWorkspaceRoot = process.env.WORKSPACE_ROOT;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-artifact-blocks-'));
    process.env.WORKSPACE_ROOT = root;
    queryOneMock.mockReset();
    Object.values(workspaceMocks).forEach(mock => mock.mockReset?.());
    workspaceMocks.writable.mockResolvedValue(true);
    workspaceMocks.resolve.mockImplementation(async ({ projectId, projectRoot, relativePath }: any) => ({ projectId, projectRoot, relativePath, hostPath: path.join(projectRoot, relativePath) }));
    workspaceMocks.exists.mockResolvedValue({ exists: false, storageAuthority: 'worker' });
  });

  afterEach(async () => {
    process.env.WORKSPACE_ROOT = oldWorkspaceRoot;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('turns one tower-artifact fence into a structured markdown artifact block', () => {
    const normalized = normalizeAssistantArtifactBlocks([
      { type: 'text', text: 'Intro\n```tower-artifact path="work/report.md" title="Report"\n# Report\n\nBody\n```\nOutro' },
    ]);

    expect(normalized).toMatchObject([
      { type: 'text', text: 'Intro\n' },
      { type: 'artifact_markdown', path: 'work/report.md', title: 'Report', text: '# Report\n\nBody', status: 'pending' },
      { type: 'text', text: '\nOutro' },
    ]);
  });

  it('drops accidental outer markdown code fence wrappers around tower-artifact fences', () => {
    const normalized = normalizeAssistantArtifactBlocks([
      { type: 'text', text: '```md\n```tower-artifact path="work/report.md" title="Report"\n# Report\n```\n```' },
    ]);

    expect(normalized).toMatchObject([
      { type: 'artifact_markdown', path: 'work/report.md', title: 'Report', text: '# Report', status: 'pending' },
    ]);
  });

  it('materializes safe markdown artifacts under the session project root', async () => {
    const projectRoot = path.join(root, 'projects', 'demo');
    await fs.mkdir(projectRoot, { recursive: true });
    queryOneMock.mockResolvedValue({ visibility: 'project', cwd: projectRoot, project_root: projectRoot });

    const blocks = normalizeAssistantArtifactBlocks([
      { type: 'text', text: '```tower-artifact path="work/report.md" title="Report"\n# Report\n\nBody\n```' },
    ]);
    const saved = await materializeAssistantArtifactBlocks('session-1', blocks as any);

    await expect(fs.readFile(path.join(projectRoot, 'work', 'report.md'), 'utf8')).resolves.toBe('# Report\n\nBody\n');
    expect(saved[0]).toMatchObject({
      type: 'artifact_markdown',
      path: 'work/report.md',
      portablePath: '~/workspace/projects/demo/work/report.md',
      status: 'saved',
    });
  });

  it('refuses unsafe paths instead of writing outside artifact directories', async () => {
    const projectRoot = path.join(root, 'projects', 'demo');
    await fs.mkdir(projectRoot, { recursive: true });
    queryOneMock.mockResolvedValue({ visibility: 'project', cwd: projectRoot, project_root: projectRoot });

    const blocks = normalizeAssistantArtifactBlocks([
      { type: 'text', text: '```tower-artifact path="../outside.md"\nnope\n```' },
    ]);
    const saved = await materializeAssistantArtifactBlocks('session-1', blocks as any);

    await expect(fs.access(path.join(root, 'outside.md'))).rejects.toBeTruthy();
    expect(saved[0]).toMatchObject({ type: 'artifact_markdown', status: 'skipped', error: 'unsafe_or_unsupported_artifact_path' });
  });

  it('stores Project artifacts through workspace authority with exclusive create', async () => {
    queryOneMock.mockResolvedValue({ visibility: 'project', cwd: root, project_id: 'p1', project_root: root, user_id: 7, user_role: 'member' });
    const blocks = [{ type: 'artifact_markdown', path: 'work/report.md', title: 'Report', text: '# Report' }];
    const saved: any = await materializeAssistantArtifactBlocks('session-1', blocks as any);
    expect(saved[0]).toMatchObject({ status: 'saved', sha256: expect.any(String) });
    expect(workspaceMocks.mkdir).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 7, exclusive: false }));
    expect(workspaceMocks.write).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 7, content: '# Report\n', exclusive: true }));
    expect(await fs.stat(path.join(root, 'work/report.md')).catch(() => null)).toBeNull();
  });

  it('uses CAS for an existing Project artifact and refuses revoked writes', async () => {
    queryOneMock.mockResolvedValue({ visibility: 'project', cwd: root, project_id: 'p1', project_root: root, user_id: 7, user_role: 'member' });
    workspaceMocks.exists.mockResolvedValue({ exists: true, storageAuthority: 'worker' });
    workspaceMocks.read.mockResolvedValue({ storageKind: 'worker', bytes: Buffer.from('old\n') });
    const blocks = [{ type: 'artifact_markdown', path: 'work/report.md', text: 'new' }];
    await materializeAssistantArtifactBlocks('session-1', blocks as any);
    expect(workspaceMocks.cas).toHaveBeenCalledWith(expect.objectContaining({ expectedContent: 'old\n', content: 'new\n' }));
    workspaceMocks.writable.mockResolvedValueOnce(false);
    const denied: any = await materializeAssistantArtifactBlocks('session-1', blocks as any);
    expect(denied[0]).toMatchObject({ status: 'error', error: 'PROJECT_FILE_WRITE_ACCESS_REVOKED' });
  });

  it('preserves the entire body including diagrams and following text', () => {
    const body = '# Report\n\n```mermaid\nflowchart LR\n A["A"] --> B["B"]\n```\n\n## After diagram\nBody';
    const blocks = normalizeAssistantArtifactBlocks([{ type: 'text', text: '```tower-artifact path="work/report.md"\n' + body + '\n```' }]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'artifact_markdown', text: body });
  });
});

it('materializes private conversation output in shared Agent storage', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-private-artifact-'));
  queryOneMock.mockResolvedValue({ visibility: 'private', cwd: root });
  const saved: any = await materializeAssistantArtifactBlocks('private', normalizeAssistantArtifactBlocks([
    { type: 'text', text: '```tower-artifact path="work/private.md"\n# Private\n```' },
  ]) as any);
  expect(saved[0]).not.toMatchObject({ status: 'error' });
  try { await expect(fs.access(path.join(root, 'work/private.md'))).resolves.toBeUndefined(); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
});
