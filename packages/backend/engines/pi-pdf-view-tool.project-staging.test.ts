import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPdfViewTool } from './pi-pdf-view-tool.js';

const attachmentMocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../services/session-attachments/session-attachment-store.js', () => ({ resolveAuthorizedSessionAttachment: attachmentMocks.resolve }));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-pdf-view-stage-test-'));
  roots.push(root);
  const file = path.join(root, 'deck.pdf');
  await fs.writeFile(file, 'HOST-SHADOW-MUST-NOT-BE-READ');
  const bytes = Buffer.from('%PDF-1.4\nWORKER-PDF');
  const projectSource = {
    async stat() { return { isFile: () => true, size: bytes.length }; },
    async readProbe(_target: string, max: number) { return bytes.subarray(0, max); },
    async readFile(_target: string, max: number) { expect(max).toBe(100 * 1024 * 1024); return bytes; },
  };
  return { root, file, bytes, projectSource };
}

describe('pdf_view Project staging', () => {
  it('preserves page/DPI options, stable identity and the original source path', async () => {
    const { root, file, bytes, projectSource } = await fixture();
    let staged = '';
    const renderPdf = vi.fn(async (args: any) => {
      staged = args.path;
      expect(args).toMatchObject({ pages: '2-3', dpi: 220 });
      expect(args.cacheIdentity).toMatch(new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`));
      expect(await fs.readFile(args.path)).toEqual(bytes);
      await fs.writeFile(path.join(root, 'page.png'), 'pixels');
      return { pdfPath: args.path, pageCount: 3, pages: [2, 3], dpi: 220, cacheDir: '/cache/pdf', cacheHit: false, images: [2,3].map(page => ({ page, path: path.join(root, 'page.png'), mimeType: 'image/png' as const })) };
    });
    const tool = createPdfViewTool({ cwd: root, sessionId: 's1', userId: 7, projectId: 'p1', projectRoot: root, projectSource, renderPdf });
    const result: any = await tool.execute('call-1', { path: file, pages: '2-3', dpi: 220 });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.details).toMatchObject({ pdfViewed: true, pages: [2, 3], dpi: 220, projectStaged: true });
    expect(result.content[0].text).toContain(`[Source: ${file}]`);
    await expect(fs.stat(path.dirname(staged))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('passes a session URI intact to the gateway and renders without Project persistence', async () => {
    const { root, file, bytes, projectSource } = await fixture();
    await fs.writeFile(file, bytes);
    attachmentMocks.resolve.mockResolvedValue({ path: file, document: { name: 'source.pdf' } });
    await fs.writeFile(path.join(root,'page.png'),'pixels');
    const renderPdf = vi.fn(async (args: any) => ({ pdfPath: args.path, pageCount: 1, pages: [1], dpi: 144, cacheDir: '/cache/pdf', cacheHit: false, images: [{ page:1, path:path.join(root,'page.png'), mimeType:'image/png' as const }] }));
    const tool = createPdfViewTool({ cwd: root, sessionId: 's1', userId: 7, projectRoot: root+'/project', projectSource, renderPdf });
    const uri = 'session://attachments/11111111-1111-4111-8111-111111111111';
    const result: any = await tool.execute('session-pdf', { path: uri, pages: '1' });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(attachmentMocks.resolve).toHaveBeenCalledWith(7,'s1',uri);
    const staged = renderPdf.mock.calls[0][0].path;
    expect(staged).not.toBe(file);
    await expect(fs.stat(staged)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(attachmentMocks.resolve).toHaveBeenCalledTimes(2);
    expect(await fs.readdir(root)).toEqual(['deck.pdf','page.png']);
  });

  it('cleans staged bytes when explicit rendering fails', async () => {
    const { root, file, projectSource } = await fixture();
    let staged = '';
    const renderPdf = vi.fn(async (args: any) => { staged = args.path; throw new Error('synthetic pdf_view failure'); });
    const tool = createPdfViewTool({ cwd: root, sessionId: 's1', userId: 7, projectId: 'p1', projectRoot: root, projectSource, renderPdf });
    const result: any = await tool.execute('call-2', { path: file, pages: '1', dpi: 144 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('synthetic pdf_view failure');
    await expect(fs.stat(path.dirname(staged))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
