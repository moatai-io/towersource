/**
 * Client-side file optimization — PDF chunking + image recompression.
 *
 * Ported from the ad-hoc tool at file-optimizer.demo-org.tower.example.com
 * (built by an OKU operator to work around Tower's upload ceiling).
 * Bringing it into Tower itself so users don't have to leave the chat.
 *
 * Design:
 *   - Runs in the browser. No server round-trip before upload.
 *   - Lazy-loads pdf-lib (~120KB gzip) only when a large PDF is dropped.
 *   - Images use Canvas + toBlob('image/jpeg', q). Tiered by input size.
 *   - PDFs split into ~8MB page-range chunks using pdf-lib.
 *   - If optimization makes the file *bigger* (already-compressed input),
 *     the original is returned unchanged — never make users worse off.
 *
 * See workspace/decisions/2026-04-24-in-chat-file-optimization.md
 */

export interface OptimizationResult {
  /** Output files. A single PDF may split into N chunks; images stay 1:1. */
  files: File[];
  originalBytes: number;
  optimizedBytes: number;
  /** Human-readable summary, e.g. "3200×2400 → 2000×1500, Q0.82". */
  note?: string;
  /** True when we actually transformed the file. */
  changed: boolean;
}

// Below these thresholds we leave files alone — not worth the CPU / quality loss.
const IMAGE_MIN_BYTES = 1.5 * 1024 * 1024;      // 1.5MB
const PDF_MIN_BYTES = 10 * 1024 * 1024;          // 10MB
// Target chunk size when splitting PDFs. `splitPdf` also skips whenever
// page count would collapse to a single chunk, so a separate page-count
// gate isn't needed here.
const PDF_TARGET_CHUNK_BYTES = 8 * 1024 * 1024;  // aim ~8MB per chunk

export async function optimizeIfNeeded(file: File): Promise<OptimizationResult> {
  const identity: OptimizationResult = {
    files: [file],
    originalBytes: file.size,
    optimizedBytes: file.size,
    changed: false,
  };

  try {
    if (isImage(file) && file.size > IMAGE_MIN_BYTES) {
      return await optimizeImage(file);
    }
    if (isPdf(file) && (file.size > PDF_MIN_BYTES)) {
      return await splitPdf(file);
    }
  } catch (err) {
    // Any optimizer failure → fall back to original. Never block the upload.
    console.warn('[file-optimizer] falling back to original:', err);
  }
  return identity;
}

/**
 * Optimize a batch. Returns flat list of resulting files + aggregate stats.
 */
export async function optimizeBatch(files: File[]): Promise<{
  files: File[];
  originalBytes: number;
  optimizedBytes: number;
  changedCount: number;
  notes: string[];
}> {
  const out: File[] = [];
  const notes: string[] = [];
  let originalBytes = 0;
  let optimizedBytes = 0;
  let changedCount = 0;
  for (const f of files) {
    const r = await optimizeIfNeeded(f);
    out.push(...r.files);
    originalBytes += r.originalBytes;
    optimizedBytes += r.optimizedBytes;
    if (r.changed) {
      changedCount++;
      if (r.note) notes.push(`${f.name}: ${r.note}`);
    }
  }
  return { files: out, originalBytes, optimizedBytes, changedCount, notes };
}

function isImage(file: File): boolean {
  return /^image\/(jpeg|png|webp)$/i.test(file.type) ||
         /\.(jpe?g|png|webp)$/i.test(file.name);
}

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

// ───── Image: Canvas resize + JPEG re-encode ─────

async function optimizeImage(file: File): Promise<OptimizationResult> {
  const tier = pickImageTier(file.size);
  const bitmap = await createImageBitmap(file);
  const longEdge = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, tier.maxEdge / longEdge);
  const targetW = Math.max(1, Math.round(bitmap.width * scale));
  const targetH = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close?.();
    return identityResult(file);
  }
  ctx.drawImage(bitmap, 0, 0, targetW, targetH);
  bitmap.close?.();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', tier.quality),
  );

  if (!blob || blob.size >= file.size) {
    // Already-compressed input — optimizer would hurt, keep original.
    return identityResult(file);
  }

  const newName = replaceExt(file.name, '.jpg', '__opt');
  const out = new File([blob], newName, { type: 'image/jpeg', lastModified: Date.now() });
  return {
    files: [out],
    originalBytes: file.size,
    optimizedBytes: out.size,
    note: `${bitmap.width}×${bitmap.height} → ${targetW}×${targetH}, Q${tier.quality}`,
    changed: true,
  };
}

interface ImageTier { maxEdge: number; quality: number; }
function pickImageTier(bytes: number): ImageTier {
  if (bytes <= 5 * 1024 * 1024)  return { maxEdge: 2400, quality: 0.88 };
  if (bytes <= 15 * 1024 * 1024) return { maxEdge: 2000, quality: 0.82 };
  return { maxEdge: 1600, quality: 0.75 };
}

// ───── PDF: page-range chunking via pdf-lib ─────

async function splitPdf(file: File): Promise<OptimizationResult> {
  // Lazy load — pdf-lib is ~120KB gzip, only pay when a big PDF is dropped.
  const { PDFDocument } = await import('pdf-lib');
  const buf = await file.arrayBuffer();
  const src = await PDFDocument.load(buf, { ignoreEncryption: true });
  const pageCount = src.getPageCount();

  // If both small enough, don't split — optimizeIfNeeded() gate already
  // caught size, but also skip tiny page counts.
  if (pageCount <= 1) return identityResult(file);

  const avgPageBytes = file.size / pageCount;
  const pagesPerChunk = Math.max(
    1,
    Math.floor(PDF_TARGET_CHUNK_BYTES / Math.max(1, avgPageBytes)),
  );
  const chunkCount = Math.ceil(pageCount / pagesPerChunk);

  // If chunking would produce a single chunk = same as input, skip.
  if (chunkCount <= 1) return identityResult(file);

  const outFiles: File[] = [];
  let total = 0;
  const baseName = file.name.replace(/\.pdf$/i, '');
  for (let i = 0; i < chunkCount; i++) {
    const start = i * pagesPerChunk;
    const end = Math.min(start + pagesPerChunk, pageCount);
    const chunk = await PDFDocument.create();
    const copied = await chunk.copyPages(src, range(start, end));
    copied.forEach((p) => chunk.addPage(p));
    const bytes = await chunk.save();
    total += bytes.byteLength;
    const name = `${baseName}__p${start + 1}-${end}.pdf`;
    outFiles.push(new File([bytes as BlobPart], name, {
      type: 'application/pdf',
      lastModified: Date.now(),
    }));
  }

  return {
    files: outFiles,
    originalBytes: file.size,
    optimizedBytes: total,
    note: `${pageCount}p → ${chunkCount} chunks × ~${pagesPerChunk}p`,
    changed: true,
  };
}

// ───── helpers ─────

function identityResult(file: File): OptimizationResult {
  return {
    files: [file],
    originalBytes: file.size,
    optimizedBytes: file.size,
    changed: false,
  };
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

function replaceExt(name: string, newExt: string, suffix: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base}${suffix}${newExt}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
