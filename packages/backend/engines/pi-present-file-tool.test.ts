import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import path from 'path';
import os from 'os';

vi.mock('../services/pm/project-access.js', () => ({
  isPathAccessible: vi.fn(async () => true),
}));

const readText = (result: any) => result.content?.[0]?.text || '';

describe('present_file Pi tool', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tower-present-file-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns a structured Viewer Pane presentation contract for an existing accessible file', async () => {
    const { createPresentFileTool } = await import('./pi-present-file-tool.js');
    const filePath = path.join(dir, 'report.md');
    await writeFile(filePath, '# Report\n');

    const tool = createPresentFileTool({ userId: 7, userRole: 'member', cwd: dir });
    const result = await tool.execute('call-1', { path: 'report.md', split: 'bottom', label: 'Executive report' });

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(readText(result));
    expect(payload).toMatchObject({
      ok: true,
      action: 'present_file',
      path: filePath,
      split: 'right',
      pane: 'right',
      label: 'Executive report',
      focus: true,
    });
  });

  it('does not present missing files', async () => {
    const { createPresentFileTool } = await import('./pi-present-file-tool.js');
    const tool = createPresentFileTool({ userId: 7, userRole: 'member', cwd: dir });

    const result = await tool.execute('call-2', { path: 'missing.md' });

    expect(result.isError).toBe(true);
    expect(readText(result)).toContain('path is not an existing file');
  });
});
