import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { renderPdfToCachedImages } from '../pi-pdf-view-tool.js';
import { preparePdfVisualBatch } from './pdf-visual-batch.js';

let root: string | undefined;
afterEach(async () => { if(root) await fs.rm(root,{recursive:true,force:true}); });
let fitz = false;
try { execFileSync('python3',['-c','import fitz'],{stdio:'ignore'}); fitz=true; } catch { /* optional renderer */ }

(fitz ? it : it.skip)('renders only the requested batch and preserves remaining coverage across the next call', async () => {
  root=await fs.mkdtemp(path.join(os.tmpdir(),'pdf-render-batch-'));
  const source=path.join(root,'document.pdf');
  execFileSync('python3',['-c',`import fitz\nd=fitz.open()\nfor n in range(5):\n p=d.new_page();p.insert_text((40,40),'Batch page '+str(n+1))\nd.save(${JSON.stringify(source)})`]);
  const first=await renderPdfToCachedImages({cwd:root,path:source,pages:'all',dpi:144,modelBatch:true});
  expect(first.pages).toEqual([1,2]); expect(first.requestedPages).toEqual([1,2,3,4,5]);
  expect(first.images).toHaveLength(2);
  expect((await fs.readdir(first.cacheDir)).filter(name=>name.endsWith('.png'))).toHaveLength(2);
  const batch=await preparePdfVisualBatch(first);
  expect(batch.coverage.nextCall?.pages).toBe('3-5');
  const next=await renderPdfToCachedImages({cwd:root,path:source,pages:batch.coverage.nextCall!.pages,dpi:144,modelBatch:true});
  expect(next.pages).toEqual([3,4]);
  expect((await preparePdfVisualBatch(next)).coverage.nextCall?.pages).toBe('5');
  const final=await renderPdfToCachedImages({cwd:root,path:source,pages:'5',dpi:144,modelBatch:true});
  expect((await preparePdfVisualBatch(final)).coverage.complete).toBe(true);
  expect(await fs.readdir(root)).toEqual(['document.pdf']);
}, 30_000);

(fitz ? it : it.skip)('reads extensionless PDF by content and rejects non-PDF content', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-extensionless-'));
  const source = path.join(root, 'business-document');
  execFileSync('python3', ['-c', `import fitz
d=fitz.open()
p=d.new_page();p.insert_text((40,40),'Synthetic registration')
d.save(${JSON.stringify(source)})`]);
  const rendered = await renderPdfToCachedImages({ cwd: root, path: source, pages: '1', dpi: 110, modelBatch: true });
  expect(rendered.pages).toEqual([1]);
  const fake = path.join(root, 'not-a-pdf.pdf'); await fs.writeFile(fake, 'Plain text');
  await expect(renderPdfToCachedImages({ cwd: root, path: fake })).rejects.toThrow('requires PDF content');
}, 30_000);
