import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { analyzePdfFontPostflight, chromiumUserDataDir, compactPdfExportPreview, createPdfExportTool, exportHtmlToPdf, findChromium, isSnapChromiumShim, PDF_EXPORT_INLINE_PREVIEW_BYTES, resolvePdfExportPath, resolvePdfExportRendererConfig } from '../pi-pdf-export-tool.js';
import { renderPdfToCachedImages } from '../pi-pdf-view-tool.js';

// These renderer tests have no database Session. Admission is covered by session-artifact-privacy.test.ts.
vi.mock('../../services/session/session-artifact-privacy.js', () => ({ assertSessionAllowsSharedArtifactWrite: vi.fn(async () => {}) }));
const tempDirs: string[] = [];

async function makeTempDir(prefix: string) {
  // Keep this E2E test under the workspace, matching real Tower artifact paths
  // and avoiding host-specific temporary directory policies.
  const workspaceBase = path.join(os.homedir(), 'workspace', 'projects', 'tower', 'experiments');
  await fs.mkdir(workspaceBase, { recursive: true });
  const dir = await fs.mkdtemp(path.join(workspaceBase, prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('Pi PDF export verification-image reuse guidance', () => {
  it('reuses returned images while allowing necessary follow-up views', () => {
    const tool = createPdfExportTool({ cwd: process.cwd(), sessionId: 'test-session' });
    expect(tool.description).toContain('Reuse returned verification images');
    const guidance = tool.promptGuidelines!.join(' ');
    expect(guidance).toContain('instead of calling pdf_view again');
    expect(guidance).toContain('images were omitted or are no longer available');
    expect(guidance).toContain('the PDF changed');
    expect(guidance).toContain('additional pages or higher resolution');
  });
});

describe('Pi PDF export automatic preview budget', () => {
  it('keeps a small preview and replaces an oversized unreadable image with a pdf_view instruction', async () => {
    const small = { type: 'image' as const, mimeType: 'image/png', data: Buffer.alloc(1024).toString('base64') };
    const large = { type: 'image' as const, mimeType: 'image/png', data: Buffer.alloc(PDF_EXPORT_INLINE_PREVIEW_BYTES + 1).toString('base64') };
    const result = await compactPdfExportPreview([small, large]);
    expect(result[0]).toEqual(small);
    expect(result[1]).toMatchObject({ type: 'text', text: expect.stringContaining('pdf_view') });
    expect(result.some((part: any) => part.type === 'image' && part.data === large.data)).toBe(false);
  });

  it('keeps the aggregate inline images under the PDF export budget across pages', async () => {
    const images = [1, 2, 3].map((page) => ({ type: 'image' as const, mimeType: 'image/png', data: Buffer.alloc(55 * 1024, page).toString('base64') }));
    const result = await compactPdfExportPreview(images);
    const inlineBytes = result.reduce((sum, part: any) => sum + (part.type === 'image' ? Buffer.from(part.data, 'base64').length : 0), 0);
    expect(inlineBytes).toBeLessThanOrEqual(PDF_EXPORT_INLINE_PREVIEW_BYTES);
    expect(result.filter((part: any) => part.type === 'image')).toHaveLength(2);
    expect(result[2]).toMatchObject({ type: 'text', text: expect.stringContaining('pdf_view') });
  });
});

describe('Pi PDF harness path handling', () => {
  it('resolves Runtime Box /workspace paths against the explicit session project root', () => {
    const resolved = resolvePdfExportPath('/workspace/final/report.html', '/home/tower/tower', '/home/tower/workspace/projects/acme');

    expect(resolved).toBe('/home/tower/workspace/projects/acme/final/report.html');
  });

  it('rejects Runtime Box paths that escape the project root', () => {
    expect(() => resolvePdfExportPath('/workspace/../other/report.html', '/home/tower/tower', '/home/tower/workspace/projects/acme')).toThrow(/escapes project root/);
  });

  it('resolves relative paths from a Runtime Box cwd through the session project root', () => {
    const resolved = resolvePdfExportPath('final/report.html', '/workspace/work', '/home/tower/workspace/projects/acme');

    expect(resolved).toBe('/home/tower/workspace/projects/acme/work/final/report.html');
  });

  it('fails loudly for Runtime Box paths when session project root is missing', () => {
    expect(() => resolvePdfExportPath('/workspace/final/report.html', '/home/tower/tower')).toThrow(/no sessionProjectRoot/);
  });
});

describe('Pi PDF renderer selection', () => {
  it('keeps system Chromium as the default and ignores unknown modes', () => {
    expect(resolvePdfExportRendererConfig({})).toEqual({ mode: 'system', nixRendererBin: null });
    expect(resolvePdfExportRendererConfig({ PDF_EXPORT_RENDERER_MODE: 'unexpected' })).toEqual({ mode: 'system', nixRendererBin: null });
  });

  it('enables the Nix renderer only with an explicit mode and absolute binary path', () => {
    expect(resolvePdfExportRendererConfig({ PDF_EXPORT_RENDERER_MODE: 'nix', NIX_RENDERER_BIN: 'relative/renderer' })).toEqual({
      mode: 'nix',
      nixRendererBin: null,
    });
    expect(resolvePdfExportRendererConfig({ PDF_EXPORT_RENDERER_MODE: 'nix', NIX_RENDERER_BIN: '/nix/store/example/bin/tower-nix-render' })).toEqual({
      mode: 'nix',
      nixRendererBin: '/nix/store/example/bin/tower-nix-render',
    });
  });
});

describe('Pi PDF Chromium selection', () => {
  it('skips snap Chromium shims unless CHROMIUM_PATH explicitly points at that shim', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-pdf-snap-shim-test-'));
    tempDirs.push(dir);
    const snapShim = path.join(dir, 'chromium-browser');
    const realChromium = path.join(dir, 'chrome');
    await fs.writeFile(snapShim, '#!/bin/sh\nexec /snap/bin/chromium "$@"\n', 'utf8');
    await fs.writeFile(realChromium, '#!/bin/sh\necho Chromium\n', 'utf8');

    expect(isSnapChromiumShim(snapShim)).toBe(true);
    expect(isSnapChromiumShim(realChromium)).toBe(false);
    expect(findChromium([snapShim, realChromium])).toBe(realChromium);

    const previous = process.env.CHROMIUM_PATH;
    process.env.CHROMIUM_PATH = snapShim;
    try {
      expect(findChromium([snapShim, realChromium])).toBe(snapShim);
    } finally {
      if (previous === undefined) delete process.env.CHROMIUM_PATH;
      else process.env.CHROMIUM_PATH = previous;
    }
  });

  it('does not choose Playwright Chromium by default without explicit opt-in', async () => {
    const previousHome = process.env.HOME;
    const previousAllow = process.env.PDF_EXPORT_ALLOW_PLAYWRIGHT_CHROMIUM;
    const previousChromiumPath = process.env.CHROMIUM_PATH;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-pdf-playwright-default-test-'));
    tempDirs.push(dir);
    const playwrightChrome = path.join(dir, '.cache', 'ms-playwright', 'chromium-999', 'chrome-linux64', 'chrome');
    await fs.mkdir(path.dirname(playwrightChrome), { recursive: true });
    await fs.writeFile(playwrightChrome, '#!/bin/sh\necho Chromium\n', 'utf8');

    try {
      process.env.HOME = dir;
      delete process.env.CHROMIUM_PATH;
      delete process.env.PDF_EXPORT_ALLOW_PLAYWRIGHT_CHROMIUM;
      expect(findChromium([null, process.env.PDF_EXPORT_ALLOW_PLAYWRIGHT_CHROMIUM === '1' ? playwrightChrome : null])).toBe(null);

      process.env.PDF_EXPORT_ALLOW_PLAYWRIGHT_CHROMIUM = '1';
      expect(findChromium([null, process.env.PDF_EXPORT_ALLOW_PLAYWRIGHT_CHROMIUM === '1' ? playwrightChrome : null])).toBe(playwrightChrome);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousAllow === undefined) delete process.env.PDF_EXPORT_ALLOW_PLAYWRIGHT_CHROMIUM;
      else process.env.PDF_EXPORT_ALLOW_PLAYWRIGHT_CHROMIUM = previousAllow;
      if (previousChromiumPath === undefined) delete process.env.CHROMIUM_PATH;
      else process.env.CHROMIUM_PATH = previousChromiumPath;
    }
  });

  it('uses an export-scoped non-snap profile directory even when snap common exists', async () => {
    const dir = await chromiumUserDataDir();
    tempDirs.push(dir);

    expect(dir).toContain(path.join('.cache', 'tower', 'pdf-export-profiles'));
    expect(dir).not.toContain(path.join('snap', 'chromium', 'common'));
  });
});

describe('Pi PDF font postflight', () => {
  it('warns when document PDF contains mostly unnamed Type 3 fonts and no named Korean font', () => {
    const sample = `name                                 type              encoding         emb sub uni object ID
------------------------------------ ----------------- ---------------- --- --- --- ---------
[none]                               Type 3            Custom           yes no  yes     24  0
[none]                               Type 3            Custom           yes no  yes     25  0
[none]                               Type 3            Custom           yes no  yes     26  0
[none]                               Type 3            Custom           yes no  yes     27  0
[none]                               Type 3            Custom           yes no  yes     28  0
[none]                               Type 3            Custom           yes no  yes     29  0
[none]                               Type 3            Custom           yes no  yes     30  0
[none]                               Type 3            Custom           yes no  yes     31  0
[none]                               Type 3            Custom           yes no  yes     32  0
FAAAAA+LiberationSans                CID TrueType      Identity-H       yes yes yes    151  0`;

    const summary = analyzePdfFontPostflight(sample, 'document');

    expect(summary.stats?.unnamedType3Rows).toBe(9);
    expect(summary.findings.map((f) => f.code)).toContain('unnamed-type3-fonts');
    expect(summary.findings.map((f) => f.code)).toContain('missing-named-korean-font-embed');
  });

  it('does not warn for image PDFs even when pdffonts sees image-mode internals', () => {
    const sample = `name                                 type              encoding         emb sub uni object ID
------------------------------------ ----------------- ---------------- --- --- --- ---------
[none]                               Type 3            Custom           yes no  yes     24  0`;

    const summary = analyzePdfFontPostflight(sample, 'image');

    expect(summary.findings).toEqual([]);
  });
});

// renderPdfToCachedImages / verification spawns plain `python3 -c "import fitz"`.
// The dev VM's Nix python ships PyMuPDF, but a clean preflight snapshot may not.
// Gate fitz-dependent cases so a missing PyMuPDF skips instead of failing.
function hasPythonFitz(): boolean {
  try {
    execFileSync('python3', ['-c', 'import fitz'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const chromiumAvailable = Boolean(findChromium());
const fitzAvailable = hasPythonFitz();
const pdfExportIt = chromiumAvailable ? it : it.skip;
// These cases both export a PDF and re-render it to verification images, so
// they need Chromium and PyMuPDF together.
const pdfVisionIt = chromiumAvailable && fitzAvailable ? it : it.skip;

describe('Pi PDF optional Nix renderer fallback', () => {
  pdfExportIt('falls back to system Chromium when the configured Nix renderer is missing', async () => {
    const cwd = await makeTempDir('tower-pdf-nix-fallback-test-');
    const htmlPath = path.join(cwd, 'fallback.html');
    const pdfPath = path.join(cwd, 'fallback.pdf');
    await fs.writeFile(htmlPath, '<!doctype html><html><body><h1>Nix fallback works</h1></body></html>', 'utf8');
    const previousMode = process.env.PDF_EXPORT_RENDERER_MODE;
    const previousBin = process.env.NIX_RENDERER_BIN;
    try {
      process.env.PDF_EXPORT_RENDERER_MODE = 'nix';
      process.env.NIX_RENDERER_BIN = path.join(cwd, 'missing-renderer');
      const renderer = await exportHtmlToPdf({ inputPath: htmlPath, outputPath: pdfPath, waitMs: 100 });
      expect(renderer.requested).toBe('nix');
      expect(renderer.used).toBe('system');
      expect(renderer.fallback).toBe(true);
      expect(renderer.fallbackReason).toMatch(/ENOENT|no such file/i);
      expect((await fs.stat(pdfPath)).size).toBeGreaterThan(1000);
    } finally {
      if (previousMode === undefined) delete process.env.PDF_EXPORT_RENDERER_MODE;
      else process.env.PDF_EXPORT_RENDERER_MODE = previousMode;
      if (previousBin === undefined) delete process.env.NIX_RENDERER_BIN;
      else process.env.NIX_RENDERER_BIN = previousBin;
    }
  }, 30000);

  pdfExportIt.each([
    {
      label: 'exit 1',
      body: '#!/bin/sh\necho renderer-failed >&2\nexit 1\n',
      timeoutMs: undefined,
      reason: /exited 1.*renderer-failed/is,
    },
    {
      label: 'empty output',
      body: '#!/bin/sh\n: > "$2"\n',
      timeoutMs: undefined,
      reason: /empty PDF/i,
    },
    {
      label: 'timeout',
      body: '#!/bin/sh\nsleep 10\n',
      timeoutMs: '50',
      reason: /timed out/i,
    },
  ])('falls back to system Chromium when the Nix renderer returns $label', async ({ body, timeoutMs, reason }) => {
    const cwd = await makeTempDir('tower-pdf-nix-failure-test-');
    const htmlPath = path.join(cwd, 'failure.html');
    const pdfPath = path.join(cwd, 'failure.pdf');
    const rendererPath = path.join(cwd, 'failing-renderer');
    await fs.writeFile(htmlPath, '<!doctype html><html><body><h1>Fallback fixture</h1></body></html>', 'utf8');
    await fs.writeFile(rendererPath, body, { encoding: 'utf8', mode: 0o755 });
    const previousMode = process.env.PDF_EXPORT_RENDERER_MODE;
    const previousBin = process.env.NIX_RENDERER_BIN;
    const previousTimeout = process.env.PDF_EXPORT_NIX_RENDERER_TIMEOUT_MS;
    try {
      process.env.PDF_EXPORT_RENDERER_MODE = 'nix';
      process.env.NIX_RENDERER_BIN = rendererPath;
      if (timeoutMs) process.env.PDF_EXPORT_NIX_RENDERER_TIMEOUT_MS = timeoutMs;
      else delete process.env.PDF_EXPORT_NIX_RENDERER_TIMEOUT_MS;
      const renderer = await exportHtmlToPdf({ inputPath: htmlPath, outputPath: pdfPath, waitMs: 100 });
      expect(renderer).toMatchObject({ requested: 'nix', used: 'system', fallback: true });
      expect(renderer.fallbackReason).toMatch(reason);
      expect(renderer.nixDurationMs).toBeGreaterThanOrEqual(0);
      expect(renderer.systemDurationMs).toBeGreaterThanOrEqual(0);
      expect((await fs.stat(pdfPath)).size).toBeGreaterThan(1000);
    } finally {
      if (previousMode === undefined) delete process.env.PDF_EXPORT_RENDERER_MODE;
      else process.env.PDF_EXPORT_RENDERER_MODE = previousMode;
      if (previousBin === undefined) delete process.env.NIX_RENDERER_BIN;
      else process.env.NIX_RENDERER_BIN = previousBin;
      if (previousTimeout === undefined) delete process.env.PDF_EXPORT_NIX_RENDERER_TIMEOUT_MS;
      else process.env.PDF_EXPORT_NIX_RENDERER_TIMEOUT_MS = previousTimeout;
    }
  }, 30000);

  it('uses an explicit renderer binary without invoking the system path', async () => {
    const cwd = await makeTempDir('tower-pdf-nix-explicit-test-');
    const htmlPath = path.join(cwd, 'explicit.html');
    const pdfPath = path.join(cwd, 'explicit.pdf');
    const rendererPath = path.join(cwd, 'fake-renderer');
    await fs.writeFile(htmlPath, '<!doctype html><html><body>explicit</body></html>', 'utf8');
    await fs.writeFile(rendererPath, '#!/bin/sh\nprintf "%s" "%PDF-1.4 fake renderer payload" > "$2"\n', { encoding: 'utf8', mode: 0o755 });
    const previousMode = process.env.PDF_EXPORT_RENDERER_MODE;
    const previousBin = process.env.NIX_RENDERER_BIN;
    try {
      process.env.PDF_EXPORT_RENDERER_MODE = 'nix';
      process.env.NIX_RENDERER_BIN = rendererPath;
      const renderer = await exportHtmlToPdf({ inputPath: htmlPath, outputPath: pdfPath, waitMs: 100 });
      expect(renderer).toMatchObject({ requested: 'nix', used: 'nix', fallback: false });
      expect(renderer.nixDurationMs).toBeGreaterThanOrEqual(0);
      expect(renderer.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(await fs.readFile(pdfPath, 'utf8')).toContain('fake renderer payload');
    } finally {
      if (previousMode === undefined) delete process.env.PDF_EXPORT_RENDERER_MODE;
      else process.env.PDF_EXPORT_RENDERER_MODE = previousMode;
      if (previousBin === undefined) delete process.env.NIX_RENDERER_BIN;
      else process.env.NIX_RENDERER_BIN = previousBin;
    }
  });

  pdfExportIt('falls back after an explicit renderer exits non-zero', async () => {
    const cwd = await makeTempDir('tower-pdf-nix-exit-test-');
    const htmlPath = path.join(cwd, 'exit.html');
    const pdfPath = path.join(cwd, 'exit.pdf');
    const rendererPath = path.join(cwd, 'exit-renderer');
    await fs.writeFile(htmlPath, '<!doctype html><html><body>exit fallback</body></html>', 'utf8');
    await fs.writeFile(rendererPath, '#!/bin/sh\necho deliberate failure >&2\nexit 7\n', { encoding: 'utf8', mode: 0o755 });
    const previous = { mode: process.env.PDF_EXPORT_RENDERER_MODE, bin: process.env.NIX_RENDERER_BIN };
    try {
      process.env.PDF_EXPORT_RENDERER_MODE = 'nix';
      process.env.NIX_RENDERER_BIN = rendererPath;
      const renderer = await exportHtmlToPdf({ inputPath: htmlPath, outputPath: pdfPath, waitMs: 100 });
      expect(renderer).toMatchObject({ requested: 'nix', used: 'system', fallback: true });
      expect(renderer.fallbackReason).toContain('exited 7');
      expect((await fs.stat(pdfPath)).size).toBeGreaterThan(1000);
    } finally {
      if (previous.mode === undefined) delete process.env.PDF_EXPORT_RENDERER_MODE; else process.env.PDF_EXPORT_RENDERER_MODE = previous.mode;
      if (previous.bin === undefined) delete process.env.NIX_RENDERER_BIN; else process.env.NIX_RENDERER_BIN = previous.bin;
    }
  }, 30000);

  pdfExportIt('falls back when an explicit renderer times out', async () => {
    const cwd = await makeTempDir('tower-pdf-nix-timeout-test-');
    const htmlPath = path.join(cwd, 'timeout.html');
    const pdfPath = path.join(cwd, 'timeout.pdf');
    const rendererPath = path.join(cwd, 'timeout-renderer');
    await fs.writeFile(htmlPath, '<!doctype html><html><body>timeout fallback</body></html>', 'utf8');
    await fs.writeFile(rendererPath, '#!/bin/sh\nexec sleep 10\n', { encoding: 'utf8', mode: 0o755 });
    const previous = { mode: process.env.PDF_EXPORT_RENDERER_MODE, bin: process.env.NIX_RENDERER_BIN, timeout: process.env.PDF_EXPORT_NIX_RENDERER_TIMEOUT_MS };
    try {
      process.env.PDF_EXPORT_RENDERER_MODE = 'nix';
      process.env.NIX_RENDERER_BIN = rendererPath;
      process.env.PDF_EXPORT_NIX_RENDERER_TIMEOUT_MS = '50';
      const renderer = await exportHtmlToPdf({ inputPath: htmlPath, outputPath: pdfPath, waitMs: 100 });
      expect(renderer).toMatchObject({ requested: 'nix', used: 'system', fallback: true });
      expect(renderer.fallbackReason).toContain('timed out');
      expect((await fs.stat(pdfPath)).size).toBeGreaterThan(1000);
    } finally {
      if (previous.mode === undefined) delete process.env.PDF_EXPORT_RENDERER_MODE; else process.env.PDF_EXPORT_RENDERER_MODE = previous.mode;
      if (previous.bin === undefined) delete process.env.NIX_RENDERER_BIN; else process.env.NIX_RENDERER_BIN = previous.bin;
      if (previous.timeout === undefined) delete process.env.PDF_EXPORT_NIX_RENDERER_TIMEOUT_MS; else process.env.PDF_EXPORT_NIX_RENDERER_TIMEOUT_MS = previous.timeout;
    }
  }, 30000);

  pdfExportIt('falls back when an explicit renderer creates an empty PDF', async () => {
    const cwd = await makeTempDir('tower-pdf-nix-empty-test-');
    const htmlPath = path.join(cwd, 'empty.html');
    const pdfPath = path.join(cwd, 'empty.pdf');
    const rendererPath = path.join(cwd, 'empty-renderer');
    await fs.writeFile(htmlPath, '<!doctype html><html><body>empty fallback</body></html>', 'utf8');
    await fs.writeFile(rendererPath, '#!/bin/sh\n: > "$2"\n', { encoding: 'utf8', mode: 0o755 });
    const previous = { mode: process.env.PDF_EXPORT_RENDERER_MODE, bin: process.env.NIX_RENDERER_BIN };
    try {
      process.env.PDF_EXPORT_RENDERER_MODE = 'nix';
      process.env.NIX_RENDERER_BIN = rendererPath;
      const renderer = await exportHtmlToPdf({ inputPath: htmlPath, outputPath: pdfPath, waitMs: 100 });
      expect(renderer).toMatchObject({ requested: 'nix', used: 'system', fallback: true });
      expect(renderer.fallbackReason).toContain('empty PDF');
      expect((await fs.stat(pdfPath)).size).toBeGreaterThan(1000);
    } finally {
      if (previous.mode === undefined) delete process.env.PDF_EXPORT_RENDERER_MODE; else process.env.PDF_EXPORT_RENDERER_MODE = previous.mode;
      if (previous.bin === undefined) delete process.env.NIX_RENDERER_BIN; else process.env.NIX_RENDERER_BIN = previous.bin;
    }
  }, 30000);
});

describe('Pi PDF harness tools', () => {
  pdfVisionIt('exports Korean print-ready HTML to PDF and returns verification images', async () => {
    const cwd = await makeTempDir('tower-pdf-export-test-');
    const htmlPath = path.join(cwd, 'korean-report.html');
    const pdfPath = path.join(cwd, 'korean-report.pdf');
    await fs.writeFile(htmlPath, `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <style>
    @page { size: A4; margin: 0; }
    body { margin: 0; font-family: Arial, 'Noto Sans CJK KR', 'Nanum Gothic', sans-serif; color: #172033; }
    .page { width: 210mm; height: 297mm; padding: 24mm; box-sizing: border-box; }
    h1 { font-size: 30px; margin: 0 0 12px; }
    p { font-size: 15px; line-height: 1.7; }
    .card { margin-top: 18px; padding: 14px; border: 1px solid #d6deea; border-radius: 12px; }
  </style>
</head>
<body>
  <main class="page">
    <h1>한글 PDF Export 회귀 테스트</h1>
    <p>이 문서는 Chromium 기반 하네스 PDF 출력과 검증 렌더링을 확인합니다.</p>
    <section class="card">자간, 줄간격, 카드 내부 텍스트가 깨지지 않아야 합니다.</section>
  </main>
</body>
</html>`, 'utf8');

    const previousMode = process.env.PDF_EXPORT_RENDERER_MODE;
    const previousBin = process.env.NIX_RENDERER_BIN;
    process.env.PDF_EXPORT_RENDERER_MODE = 'system';
    delete process.env.NIX_RENDERER_BIN;
    const tool = createPdfExportTool({ cwd, sessionId: 'test-session' });
    let result: any;
    try {
      result = await tool.execute('test-call', {
        input_path: htmlPath,
        output_path: pdfPath,
        verify_pages: '1',
        wait_ms: 1000,
      });
    } finally {
      if (previousMode === undefined) delete process.env.PDF_EXPORT_RENDERER_MODE; else process.env.PDF_EXPORT_RENDERER_MODE = previousMode;
      if (previousBin === undefined) delete process.env.NIX_RENDERER_BIN; else process.env.NIX_RENDERER_BIN = previousBin;
    }

    expect(result.isError).not.toBe(true);
    expect(result.details.pdfExported).toBe(true);
    expect(result.details.outputPath).toBe(pdfPath);
    expect(result.details.renderer).toMatchObject({ requested: 'system', used: 'system', fallback: false });
    expect(result.content.map((block: any) => block.text || '').join('\n')).toContain('[Renderer: requested=system; used=system; fallback=no]');
    const pdfStat = await fs.stat(pdfPath);
    expect(pdfStat.size).toBeGreaterThan(1000);
    expect(result.content.some((block: any) => block.type === 'image')).toBe(true);
    expect(result.content.filter((block: any) => block.type === 'image').reduce((sum: number, block: any) => sum + Buffer.from(block.data, 'base64').length, 0)).toBeLessThanOrEqual(PDF_EXPORT_INLINE_PREVIEW_BYTES);
    expect(result.content.map((block: any) => block.text || '').join('\n')).toContain('Verification pages: 1 of 1');
  }, 30000);

  pdfVisionIt('reuses the same cache key for identical PDF path/page/dpi requests', async () => {
    const cwd = await makeTempDir('tower-pdf-cache-test-');
    const htmlPath = path.join(cwd, 'cache-source.html');
    const pdfPath = path.join(cwd, 'cache-source.pdf');
    await fs.writeFile(htmlPath, '<!doctype html><html><body><h1>Cache Test</h1></body></html>', 'utf8');

    const tool = createPdfExportTool({ cwd, sessionId: 'test-session' });
    const exported = await tool.execute('test-call', { input_path: htmlPath, output_path: pdfPath, verify_pages: '1' });
    expect(exported.isError).not.toBe(true);

    const first = await renderPdfToCachedImages({ cwd, path: pdfPath, pages: '1', dpi: 144 });
    const second = await renderPdfToCachedImages({ cwd, path: pdfPath, pages: '1', dpi: 144 });

    expect(second.cacheDir).toBe(first.cacheDir);
    expect(second.cacheHit).toBe(true);
  }, 30000);

  it('rejects raw Mermaid fences before creating a PDF', async () => {
    const cwd = await makeTempDir('tower-pdf-raw-fence-test-');
    const htmlPath = path.join(cwd, 'raw-mermaid.html');
    const pdfPath = path.join(cwd, 'raw-mermaid.pdf');
    await fs.writeFile(htmlPath, `<!doctype html><html><body><pre>\`\`\`mermaid
flowchart LR
  A[Start] --> B[End]
\`\`\`</pre></body></html>`, 'utf8');

    const tool = createPdfExportTool({ cwd, sessionId: 'test-session' });
    const result = await tool.execute('test-call', {
      input_path: htmlPath,
      output_path: pdfPath,
      verify_pages: '1',
      wait_ms: 1000,
    });

    expect(result.isError).toBe(true);
    expect(result.details.pdfExported).toBe(false);
    expect(result.content.map((block: any) => block.text || '').join('\n')).toContain('raw-mermaid-fence');
    await expect(fs.stat(pdfPath)).rejects.toThrow();
  }, 30000);

  pdfVisionIt('rejects PDFs whose extracted text still contains raw Mermaid source', async () => {
    const cwd = await makeTempDir('tower-pdf-raw-residue-test-');
    const htmlPath = path.join(cwd, 'raw-flowchart.html');
    const pdfPath = path.join(cwd, 'raw-flowchart.pdf');
    await fs.writeFile(htmlPath, `<!doctype html>
<html><body><main><h1>Broken visual export</h1><pre>flowchart LR
  A[Start] --> B[End]</pre></main></body></html>`, 'utf8');

    const tool = createPdfExportTool({ cwd, sessionId: 'test-session' });
    const result = await tool.execute('test-call', {
      input_path: htmlPath,
      output_path: pdfPath,
      verify_pages: '1',
      wait_ms: 1000,
    });

    expect(result.isError).toBe(true);
    expect(result.details.pdfExported).toBe(false);
    expect(result.content.map((block: any) => block.text || '').join('\n')).toContain('raw Mermaid/chart source');
  }, 30000);


  pdfVisionIt('exports image-mode PDF with final preview images and preflight warnings', async () => {
    const cwd = await makeTempDir('tower-pdf-image-test-');
    const htmlPath = path.join(cwd, 'visual-proposal.html');
    const pdfPath = path.join(cwd, 'visual-proposal.image.pdf');
    const previewDir = path.join(cwd, 'preview');
    await fs.writeFile(htmlPath, `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <style>
    @page { size: 1600px 900px; margin: 0; }
    body { margin: 0; font-family: Arial, 'Noto Sans CJK KR', sans-serif; }
    .page { width: 1600px; height: 900px; box-sizing: border-box; padding: 80px; background: radial-gradient(circle, rgba(255,255,255,.7), #163036); color: white; break-after: page; }
    .card { position: absolute; transform: rotate(2deg); box-shadow: 0 20px 60px rgba(0,0,0,.3); padding: 40px; background: rgba(255,255,255,.12); }
  </style>
</head>
<body>
  <section class="page"><h1>이미지 PDF 테스트</h1><div class="card">화면 보존 우선</div></section>
</body>
</html>`, 'utf8');

    const tool = createPdfExportTool({ cwd, sessionId: 'test-session' });
    const result = await tool.execute('test-call', {
      input_path: htmlPath,
      output_path: pdfPath,
      mode: 'image',
      verify_pages: '1',
      wait_ms: 1000,
      preview_output_dir: previewDir,
    });

    expect(result.isError).not.toBe(true);
    expect(result.details.pdfExported).toBe(true);
    expect(result.details.mode).toBe('image');
    expect(result.details.outputPath).toBe(pdfPath);
    expect(result.details.previewPaths.length).toBeGreaterThan(0);
    expect(result.details.preflightWarnings.length).toBeGreaterThan(0);
    expect(result.details.preflightWarnings.map((w: any) => w.code)).toContain('rgba');
    const pdfStat = await fs.stat(pdfPath);
    const previewStat = await fs.stat(result.details.previewPaths[0]);
    expect(pdfStat.size).toBeGreaterThan(1000);
    expect(previewStat.size).toBeGreaterThan(1000);
    expect(result.content.map((block: any) => block.text || '').join('\n')).toContain('mode=image');
    expect(result.content.map((block: any) => block.text || '').join('\n')).toContain('[Final preview images]');
  }, 90_000); // Image PDF export plus preview rendering contends for Chromium in the full suite.
});
