// One bounded PDF page batch. Coverage means returned pixels, not model comprehension.
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { configuredPiRequestBodyLimit } from './provider-request-budget.js';
import type { RenderPdfResult } from '../pi-pdf-view-tool.js';

export const PDF_MODEL_BATCH_PAGES = 2;
export const PDF_MODEL_BATCH_BYTES = 3 * 1024 * 1024;
export interface PdfVisualReference {
  version: 1;
  source: string;
  pages: number[];
  dpi: number;
  sourceVersion?: string;
  batchId?: string;
  pinned?: boolean;
}

/** Single page batches reserve room for parallel tools/history. Never silently
 * truncate and say every requested page was viewed. Oversized individual pages
 * require an explicit lower-DPI/region plan, not automatic quality loss.
 */
function pageSpec(pages: number[]): string {
  const parts: string[] = [];
  for (let index = 0; index < pages.length; index++) {
    const start = pages[index]; let end = start;
    while (index + 1 < pages.length && pages[index + 1] === end + 1) end = pages[++index];
    parts.push(start === end ? String(start) : `${start}-${end}`);
  }
  return parts.join(',');
}

export async function preparePdfVisualBatch(rendered: RenderPdfResult, options: { pinned?: boolean } = {}) {
  const budget = Math.min(PDF_MODEL_BATCH_BYTES, Math.floor(configuredPiRequestBodyLimit() * 0.15));
  const images: RenderPdfResult['images'] = [];
  let bytes = 0;
  for (const image of rendered.images) {
    if (images.length >= PDF_MODEL_BATCH_PAGES) break;
    const size = (await fs.stat(image.path)).size;
    if (bytes + size > budget) break;
    images.push(image); bytes += size;
  }
  const deliveredPages = images.map(image => image.page);
  const requestedPages = rendered.requestedPages || rendered.pages;
  const remainingPages = requestedPages.filter(page => !deliveredPages.includes(page));
  const reference: PdfVisualReference = { version: 1, source: rendered.pdfPath, pages: deliveredPages, dpi: rendered.dpi,
    sourceVersion: rendered.sourceVersion, pinned: options.pinned || false };
  // Each delivery is a new observation, even when the same cached pages are reopened.
  reference.batchId = randomBytes(12).toString('hex');
  const coverage = { requestedPages, deliveredPages, remainingPages,
    complete: remainingPages.length === 0, source: rendered.pdfPath, dpi: rendered.dpi,
    nextCall: remainingPages.length ? { path: rendered.pdfPath, pages: pageSpec(remainingPages).length <= 100 ? pageSpec(remainingPages) : pageSpec(remainingPages.slice(0, 10)), dpi: rendered.dpi, ...(options.pinned ? { pin: true } : {}) } : undefined };
  return { rendered: { ...rendered, images, pages: deliveredPages }, reference, coverage, bytes,
    notice: `[PDF batch coverage: requested=${requestedPages.join(',')}; returned=${deliveredPages.join(',') || 'none'}; not returned=${remainingPages.join(',') || 'none'}. Returned pixels do not prove analysis completion.]\n` +
      (images.length === 0 ? '[No page fits the model image-byte budget. Re-request specific pages with lower DPI or an appropriate detail crop; do not claim the document was read.]'
        : `[Before another PDF batch or a final answer, call pdf_observe with concise findings and uncertainties for these pages. With one pending batch omit batchId; if the tool reports ambiguous batches, select the matching batchId. Do not write special observation text tags. Records are model observations, not proof of correctness. ${options.pinned ? `Comparison images are pinned for this user task; release with [PDF unpin batch=${reference.batchId}]. ` : ''}`
          + (remainingPages.length ? `Continue with pdf_view ${JSON.stringify(coverage.nextCall)}; do not claim all pages were read.` : 'Only this range was returned, not the whole document.') + ']'),
  };
}
