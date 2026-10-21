import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const renderMock = vi.hoisted(() => vi.fn());
vi.mock('../services/agent-workspaces/team-context.js', () => ({ resolveTeamAgentContext: vi.fn(async () => null) }));
vi.mock('./pi-pdf-view-tool.js', () => ({
  renderPdfToCachedImages: renderMock,
  pdfViewResultContent: vi.fn(async (rendered: any) => [{ type: 'text', text: `[Source: ${rendered.pdfPath}]` }]),
}));
vi.mock('./pi-worker-image-read.js', () => ({ readWorkerImage: vi.fn(async () => null) }));
vi.mock('./pi-session-attachment-tool.js', () => ({ readCurrentSessionAttachmentImage: vi.fn(async () => null) }));

const { createPdfAwareReadTool } = await import('./pi-pdf-aware-read-tool.js');
const roots: string[] = [];
afterEach(async () => {
  renderMock.mockReset();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function projectFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-project-pdf-stage-test-'));
  roots.push(root);
  const file = path.join(root, 'report.pdf');
  await fs.writeFile(file, 'HOST-SHADOW-MUST-NOT-BE-READ');
  const data = Buffer.from('%PDF-1.4\nWORKER-AUTHORITATIVE');
  const readFile = vi.fn(async (_target: string, max: number) => {
    expect(max).toBe(100 * 1024 * 1024);
    return data;
  });
  return { root, file, data, readFile, projectSource: {
    async stat() { return { isFile: () => true, size: data.length }; },
    async readProbe(_target: string, max: number) { return data.subarray(0, max); },
    readFile,
  } };
}

describe('Pi Read Project PDF staging', () => {
  it('renders only the staged authoritative bytes and removes the temp source', async () => {
    const { root, file, data, readFile, projectSource } = await projectFixture();
    let stagedPath = '';
    renderMock.mockImplementation(async ({ path: inputPath, cacheIdentity }: any) => {
      stagedPath = inputPath;
      expect(cacheIdentity).toMatch(new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`));
      expect(inputPath).not.toBe(file);
      expect(await fs.readFile(inputPath)).toEqual(data);
      await fs.writeFile(path.join(root,'page.png'),'pixels');
      return { pdfPath: inputPath, pageCount: 1, pages: [1], dpi: 144, cacheDir: '/cache', cacheHit: false, images: [{ page:1,path:path.join(root,'page.png'),mimeType:'image/png' }] };
    });
    const tool = createPdfAwareReadTool({ cwd: root, projectRoot: root, sessionId: 's1', userId: 7, projectSource });
    const result = await tool.execute('call-1', { path: file }, undefined, undefined);
    expect(result.isError).not.toBe(true);
    expect(result.details).toMatchObject({ pdfAutoViewed: true, projectStaged: true });
    expect(result.content[0].text).toContain(`[Source: ${file}]`);
    expect(readFile).toHaveBeenCalledOnce();
    await expect(fs.stat(path.dirname(stagedPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reads a Project image from authoritative bytes instead of the host shadow', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-project-image-stage-test-'));
    roots.push(root);
    const file = path.join(root, 'image.png');
    await fs.writeFile(file, 'HOST-SHADOW-MUST-NOT-BE-READ');
    const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const projectSource = {
      async stat() { return { isFile: () => true, size: data.length }; },
      async readProbe(_target: string, max: number) { return data.subarray(0, max); },
      async readFile() { return data; },
    };
    const tool = createPdfAwareReadTool({ cwd: root, projectRoot: root, sessionId: 's1', userId: 7, projectSource });
    const result = await tool.execute('call-image', { path: file }, undefined, undefined);
    expect(result.isError).not.toBe(true);
    expect(result.details).toMatchObject({ projectStaged: true });
    expect(result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  });

  it('removes the staged source after a renderer failure', async () => {
    const { root, file, projectSource } = await projectFixture();
    let stagedPath = '';
    renderMock.mockImplementation(async ({ path: inputPath }: any) => {
      stagedPath = inputPath;
      throw new Error('synthetic renderer failure');
    });
    const tool = createPdfAwareReadTool({ cwd: root, projectRoot: root, sessionId: 's1', userId: 7, projectSource });
    const result = await tool.execute('call-2', { path: file }, undefined, undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('synthetic renderer failure');
    await expect(fs.stat(path.dirname(stagedPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
