/**
 * pi-pdf-view-tool.ts — harness-level PDF visual reader for Pi.
 *
 * Owns: pdf_view, a Tower/Pi harness tool that renders PDF pages into an
 * internal cache and returns inline image content for LLM vision. It does not
 * write rendered pages into the user's project folder.
 *
 * Public API:
 *   - createPdfViewTool(ctx)
 *   - renderPdfToCachedImages(args)
 */

import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import { prepareFileRepresentation, requireDetectedMime } from '../services/content-safety/file-representation-gateway.js';
import { applyModelOutputBudget } from '../services/content-safety/model-output-budget-gateway.js';

export interface PdfViewContext {
  cwd: string;
  sessionId: string;
  userId?: number;
  userRole?: string;
  projectId?: string;
}

export interface RenderPdfArgs {
  cwd: string;
  path: string;
  pages?: string;
  dpi?: number;
}

export interface RenderPdfResult {
  pdfPath: string;
  pageCount: number;
  pages: number[];
  dpi: number;
  cacheDir: string;
  cacheHit: boolean;
  images: Array<{ page: number; path: string; mimeType: 'image/png' }>;
}

const DEFAULT_PAGES = 'all';
const DEFAULT_DPI = 144;
const MAX_PAGES_PER_CALL = 100;
const CACHE_ROOT = process.env.TOWER_PDF_VIEW_CACHE_DIR || path.join(os.homedir(), '.cache', 'tower', 'pdf-view');
const CACHE_TTL_MS = Number(process.env.TOWER_PDF_VIEW_CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const CACHE_MAX_ENTRIES = Number(process.env.TOWER_PDF_VIEW_CACHE_MAX_ENTRIES || 500);
const CACHE_CLEANUP_INTERVAL_MS = Number(process.env.TOWER_PDF_VIEW_CACHE_CLEANUP_INTERVAL_MS || 6 * 60 * 60 * 1000);

const PdfViewParams = Type.Object({
  path: Type.String({
    minLength: 1,
    maxLength: 2000,
    description: 'PDF path to view. Relative paths resolve from the current session cwd.',
  }),
  pages: Type.Optional(Type.String({
    maxLength: 100,
    description: 'Pages to render, 1-based. Examples: "all", "1", "1-3", "1,3,5". Default: all, capped at 100 pages per call.',
  })),
  dpi: Type.Optional(Type.Integer({
    minimum: 72,
    maximum: 300,
    description: 'Render DPI. Default 144. Use 200-300 for small drawings/details.',
  })),
});

function resolveInputPath(inputPath: string, cwd: string): string {
  return path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(cwd, inputPath);
}

function parsePages(spec: string, total: number): number[] {
  const normalizedSpec = spec.trim().toLowerCase();
  if (normalizedSpec === 'all' || normalizedSpec === '*') {
    return Array.from({ length: Math.min(total, MAX_PAGES_PER_CALL) }, (_, i) => i + 1);
  }

  const out: number[] = [];
  for (const raw of spec.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    if (part.includes('-')) {
      const [aRaw, bRaw] = part.split('-', 2);
      const a = Number.parseInt(aRaw, 10);
      const b = Number.parseInt(bRaw, 10);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const start = Math.max(1, Math.min(a, b));
      const end = Math.min(total, Math.max(a, b));
      for (let p = start; p <= end; p += 1) out.push(p);
    } else {
      const p = Number.parseInt(part, 10);
      if (Number.isFinite(p) && p >= 1 && p <= total) out.push(p);
    }
  }
  const seen = new Set<number>();
  const unique: number[] = [];
  for (const p of out) {
    if (seen.has(p)) continue;
    seen.add(p);
    unique.push(p);
    if (unique.length >= MAX_PAGES_PER_CALL) break;
  }
  return unique;
}

async function statForKey(pdfPath: string): Promise<{ size: number; mtimeMs: number }> {
  const st = await fs.stat(pdfPath);
  return { size: st.size, mtimeMs: st.mtimeMs };
}

function cacheKey(input: { pdfPath: string; size: number; mtimeMs: number; pages: string; dpi: number }): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 24);
}

function runPythonJson(script: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || `python3 exited ${code}`).trim()));
        return;
      }
      try {
        resolve(JSON.parse(stdout || '{}'));
      } catch (err) {
        reject(new Error(`PDF renderer returned invalid JSON: ${(err as Error).message}\n${stdout.slice(0, 500)}`));
      }
    });
  });
}

async function maybeCleanupPdfViewCache(now = Date.now()): Promise<void> {
  try {
    await fs.mkdir(CACHE_ROOT, { recursive: true });
    const marker = path.join(CACHE_ROOT, '.last-cleanup');
    try {
      const st = await fs.stat(marker);
      if (now - st.mtimeMs < CACHE_CLEANUP_INTERVAL_MS) return;
    } catch {
      // No marker yet — run cleanup.
    }

    const entries = await fs.readdir(CACHE_ROOT, { withFileTypes: true });
    const dirs = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const dir = path.join(CACHE_ROOT, entry.name);
        const st = await fs.stat(dir);
        return { dir, mtimeMs: st.mtimeMs };
      }));

    const expired = dirs.filter((entry) => now - entry.mtimeMs > CACHE_TTL_MS);
    const overflow = dirs
      .filter((entry) => now - entry.mtimeMs <= CACHE_TTL_MS)
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
      .slice(0, Math.max(0, dirs.length - expired.length - CACHE_MAX_ENTRIES));

    await Promise.all([...expired, ...overflow].map((entry) => fs.rm(entry.dir, { recursive: true, force: true })));
    await fs.writeFile(marker, new Date(now).toISOString());
  } catch {
    // Cache cleanup is best-effort; viewing a PDF must not fail because cleanup failed.
  }
}

async function touchCacheDir(cacheDir: string): Promise<void> {
  const now = new Date();
  try { await fs.utimes(cacheDir, now, now); } catch { /* best effort */ }
}

async function getPageCount(pdfPath: string): Promise<number> {
  const script = [
    'import fitz, json',
    `pdf_path=${JSON.stringify(pdfPath)}`,
    'doc=fitz.open(pdf_path)',
    'print(json.dumps({"page_count": doc.page_count}))',
  ].join('\n');
  const result = await runPythonJson(script);
  return Number(result.page_count || 0);
}

async function renderMissingPages(args: {
  pdfPath: string;
  cacheDir: string;
  pages: number[];
  dpi: number;
}): Promise<void> {
  const script = [
    'import fitz, json, os',
    `pdf_path=${JSON.stringify(args.pdfPath)}`,
    `cache_dir=${JSON.stringify(args.cacheDir)}`,
    `pages=${JSON.stringify(args.pages)}`,
    `dpi=${JSON.stringify(args.dpi)}`,
    'os.makedirs(cache_dir, exist_ok=True)',
    'doc=fitz.open(pdf_path)',
    'mat=fitz.Matrix(dpi/72, dpi/72)',
    'rendered=[]',
    'for pno in pages:',
    '    out=os.path.join(cache_dir, f"page-{int(pno):03d}.png")',
    '    if os.path.exists(out):',
    '        rendered.append(out); continue',
    '    page=doc.load_page(int(pno)-1)',
    '    pix=page.get_pixmap(matrix=mat, alpha=False)',
    '    pix.save(out)',
    '    rendered.append(out)',
    'print(json.dumps({"rendered": rendered}, ensure_ascii=False))',
  ].join('\n');
  await runPythonJson(script);
}

export async function renderPdfToCachedImages(args: RenderPdfArgs): Promise<RenderPdfResult> {
  await maybeCleanupPdfViewCache();
  const pdfPath = resolveInputPath(args.path, args.cwd);
  if (!pdfPath.toLowerCase().endsWith('.pdf')) {
    throw new Error('pdf_view only accepts .pdf files.');
  }

  const dpi = args.dpi || DEFAULT_DPI;
  const pagesSpec = args.pages || DEFAULT_PAGES;
  const [stat, pageCount] = await Promise.all([statForKey(pdfPath), getPageCount(pdfPath)]);
  if (!pageCount) throw new Error('PDF has no readable pages.');

  const pages = parsePages(pagesSpec, pageCount);
  if (pages.length === 0) throw new Error(`No valid pages selected from "${pagesSpec}" for a ${pageCount}-page PDF.`);

  const key = cacheKey({ pdfPath, size: stat.size, mtimeMs: stat.mtimeMs, pages: pages.join(','), dpi });
  const cacheDir = path.join(CACHE_ROOT, key);
  await fs.mkdir(cacheDir, { recursive: true });

  const imagePaths = pages.map((p) => path.join(cacheDir, `page-${String(p).padStart(3, '0')}.png`));
  const existed = await Promise.all(imagePaths.map(async (p) => {
    try { await fs.access(p); return true; } catch { return false; }
  }));
  const cacheHit = existed.every(Boolean);
  if (!cacheHit) {
    await renderMissingPages({ pdfPath, cacheDir, pages, dpi });
    await fs.writeFile(path.join(cacheDir, 'manifest.json'), JSON.stringify({
      sourcePath: pdfPath,
      sourceSize: stat.size,
      sourceMtimeMs: stat.mtimeMs,
      pageCount,
      pages,
      dpi,
      createdAt: new Date().toISOString(),
    }, null, 2));
  }
  await touchCacheDir(cacheDir);

  return {
    pdfPath,
    pageCount,
    pages,
    dpi,
    cacheDir,
    cacheHit,
    images: pages.map((page, i) => ({ page, path: imagePaths[i], mimeType: 'image/png' as const })),
  };
}

async function imageContentForFile(imagePath: string, mimeType: 'image/png') {
  const data = await fs.readFile(imagePath);
  return { type: 'image' as const, data: data.toString('base64'), mimeType };
}

export async function pdfViewResultContent(rendered: RenderPdfResult): Promise<AgentToolResult<any>['content']> {
  const content: AgentToolResult<any>['content'] = [{
    type: 'text',
    text: [
      `Viewed PDF pages with vision [application/pdf]`,
      `[Source: ${rendered.pdfPath}]`,
      `[Pages: ${rendered.pages.join(', ')} of ${rendered.pageCount}; DPI: ${rendered.dpi}; cache: ${rendered.cacheHit ? 'hit' : 'miss'}]`,
      `[Rendered pages are stored in Tower internal cache, not in the project folder.]`,
      `[Cache cleanup: entries older than ${Math.round(CACHE_TTL_MS / (24 * 60 * 60 * 1000))} day(s) or beyond ${CACHE_MAX_ENTRIES} entries are pruned best-effort.]`,
    ].join('\n'),
  } as any];

  for (const image of rendered.images) {
    content.push({ type: 'text', text: `[PDF page ${image.page}]` } as any);
    content.push(await imageContentForFile(image.path, image.mimeType) as any);
  }
  return content;
}

export function createPdfViewTool(ctx: PdfViewContext): ToolDefinition {
  return {
    name: 'pdf_view',
    label: 'View PDF Pages',
    description: [
      'View PDF pages as images for LLM vision analysis.',
      'Use this for scanned PDFs, slide decks, drawings, forms, visually laid out reports, or any PDF where layout matters.',
      'Rendered pages are cached in Tower internal cache and are not written into the project folder.',
    ].join(' '),
    promptSnippet: 'View PDF pages by rendering them to internal cached images and sending them to LLM vision.',
    promptGuidelines: [
      'PDFs are visual documents. Use pdf_view when asked to read, inspect, review, or understand a PDF visually.',
      'Do not fail just because text extraction or OCR binaries are unavailable; pdf_view uses LLM vision on rendered pages.',
      'Use pdf_read as a supplement for tables/text, not as the only path for scanned, slide, drawing, or layout-heavy PDFs.',
      'For detailed PDF reading, page-range, batching, and table-extraction rules, use runtime_guide_read with name="pdf-analysis".',
    ],
    parameters: PdfViewParams,
    async execute(_toolCallId: string, params: { path: string; pages?: string; dpi?: number }) {
      try {
        const prepared = requireDetectedMime(await prepareFileRepresentation(params.path, {
          cwd: ctx.cwd,
          sessionId: ctx.sessionId,
          userId: ctx.userId,
        }), ['application/pdf'], 'pdf_view');
        const rendered = await renderPdfToCachedImages({
          cwd: ctx.cwd,
          path: prepared.path,
          pages: params.pages,
          dpi: params.dpi,
        });
        const budgeted = applyModelOutputBudget(await pdfViewResultContent(rendered));
        return {
          content: budgeted.content,
          details: {
            pdfViewed: true,
            pageCount: rendered.pageCount,
            pages: rendered.pages,
            dpi: rendered.dpi,
            cacheHit: rendered.cacheHit,
            cacheDir: rendered.cacheDir,
            outputBudget: budgeted,
          },
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `[pdf_view error] ${(error as Error).message}` } as any],
          details: { pdfViewed: false, error: (error as Error).message },
          isError: true,
        } as any;
      }
    },
  } as ToolDefinition;
}
