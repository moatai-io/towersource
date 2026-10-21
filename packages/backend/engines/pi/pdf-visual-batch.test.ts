import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preparePdfVisualBatch } from './pdf-visual-batch.js';
import type { RenderPdfResult } from '../pi-pdf-view-tool.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture(sizes: number[], requested = sizes.map((_, index) => index + 1)): Promise<RenderPdfResult> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'pdf-batch-')); roots.push(root);
  const images = await Promise.all(sizes.map(async (size, index) => {
    const image = path.join(root,`${index}.png`); await fs.writeFile(image,Buffer.alloc(size));
    return { page:index+1,path:image,mimeType:'image/png' as const };
  }));
  return { pdfPath:'session://attachments/source-id',pageCount:10,pages:images.map(image=>image.page),requestedPages:requested,dpi:144,cacheDir:root,cacheHit:false,images };
}
describe('explicit PDF page coverage', () => {
  it('returns a two-page batch and exact unfinished/next page instructions', async () => {
    const rendered = await fixture([100,100],[1,2,3,4,5]);
    const batch = await preparePdfVisualBatch(rendered);
    expect(batch.coverage).toMatchObject({ requestedPages:[1,2,3,4,5],deliveredPages:[1,2],remainingPages:[3,4,5],complete:false,nextCall:{path:rendered.pdfPath,pages:'3-5',dpi:144} });
    expect(batch.reference.pages).toEqual([1,2]);
    expect(batch.notice).toContain('do not claim all pages were read');
    expect(rendered.requestedPages).toEqual([1,2,3,4,5]);
  });
  it('keeps long-document remainder with a compact nextCall rather than losing pages past 100', async () => {
    const batch = await preparePdfVisualBatch(await fixture([100,100], Array.from({length:250},(_,i)=>i+1)));
    expect(batch.coverage.remainingPages).toHaveLength(248);
    expect(batch.coverage.nextCall?.pages).toBe('3-250');
  });
  it('bounds bytes without changing DPI, deleting originals or silently skipping a large page', async () => {
    const rendered = await fixture([2*1024*1024,2*1024*1024,100]);
    const batch = await preparePdfVisualBatch(rendered);
    expect(batch.coverage.deliveredPages).toEqual([1]);
    expect(batch.coverage.remainingPages).toEqual([2,3]);
    expect(batch.rendered.dpi).toBe(144);
    expect(await fs.readdir(rendered.cacheDir)).toHaveLength(3);
  });
  it('returns no pixels and an explicit detail replan when one page cannot fit', async () => {
    const rendered = await fixture([4*1024*1024]);
    const batch = await preparePdfVisualBatch(rendered);
    expect(batch.rendered.images).toEqual([]); expect(batch.coverage.complete).toBe(false);
    expect(batch.notice).toContain('No page fits'); expect(batch.notice).toContain('lower DPI');
  });
  it('scales per-tool bytes to the transport bound and preserves nonconsecutive page order', async () => {
    vi.stubEnv('PI_PROVIDER_MAX_REQUEST_BODY_BYTES','1000000');
    const rendered = await fixture([100000,100000]);
    rendered.images[0].page=7;rendered.images[1].page=3;rendered.pages=[7,3];rendered.requestedPages=[7,3];
    const batch = await preparePdfVisualBatch(rendered);
    expect(batch.coverage.deliveredPages).toEqual([7]);
    expect(batch.coverage.nextCall?.pages).toBe('3');
  });
});
