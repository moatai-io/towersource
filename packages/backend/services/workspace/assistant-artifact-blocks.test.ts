import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryOneMock = vi.fn();

vi.mock('../../db/pg-repo.js', () => ({
  queryOne: (...args: any[]) => queryOneMock(...args),
}));

const { normalizeAssistantArtifactBlocks, materializeAssistantArtifactBlocks } = await import('./assistant-artifact-blocks.js');

describe('assistant artifact blocks', () => {
  let root = '';
  const oldWorkspaceRoot = process.env.WORKSPACE_ROOT;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-artifact-blocks-'));
    process.env.WORKSPACE_ROOT = root;
    queryOneMock.mockReset();
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
    queryOneMock.mockResolvedValue({ cwd: projectRoot, project_root: projectRoot });

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
    queryOneMock.mockResolvedValue({ cwd: projectRoot, project_root: projectRoot });

    const blocks = normalizeAssistantArtifactBlocks([
      { type: 'text', text: '```tower-artifact path="../outside.md"\nnope\n```' },
    ]);
    const saved = await materializeAssistantArtifactBlocks('session-1', blocks as any);

    await expect(fs.access(path.join(root, 'outside.md'))).rejects.toBeTruthy();
    expect(saved[0]).toMatchObject({ type: 'artifact_markdown', status: 'skipped', error: 'unsafe_or_unsupported_artifact_path' });
  });
});
