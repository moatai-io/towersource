/**
 * pi-pdf-export-tool.ts — harness-level PDF export contract for Pi.
 *
 * Owns: pdf_export, a Tower/Pi harness tool for producing final PDF artifacts
 * from print-ready HTML using Chromium, then returning a visual verification
 * preview via the pdf_view renderer.
 *
 * Contract:
 *   document mode: HTML source → Chromium print PDF → output PDF file → visual verification.
 *   image mode:    HTML source → Chromium print PDF → page images → image-backed PDF → visual verification.
 */

import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { pathToFileURL } from 'url';
import { PDFDocument } from 'pdf-lib';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import { renderPdfToCachedImages, pdfViewResultContent } from './pi-pdf-view-tool.js';

export interface PdfExportContext {
  cwd: string;
  sessionId: string;
  projectRoot?: string | null;
}

export type PdfExportRendererMode = 'system' | 'nix';

export interface PdfExportRendererResult {
  requested: PdfExportRendererMode;
  used: PdfExportRendererMode;
  fallback: boolean;
  fallbackReason?: string;
  nixDurationMs?: number;
  systemDurationMs?: number;
  totalDurationMs: number;
}

export function resolvePdfExportRendererConfig(env: NodeJS.ProcessEnv = process.env): {
  mode: PdfExportRendererMode;
  nixRendererBin: string | null;
} {
  // Keep the existing system Chromium path authoritative unless operators opt
  // into the shadow renderer explicitly. Unknown values also fail closed to the
  // established system path rather than silently enabling a canary.
  const mode: PdfExportRendererMode = env.PDF_EXPORT_RENDERER_MODE === 'nix' ? 'nix' : 'system';
  const configuredBin = env.NIX_RENDERER_BIN?.trim();
  return {
    mode,
    nixRendererBin: configuredBin && path.isAbsolute(configuredBin) ? configuredBin : null,
  };
}

const PdfExportParams = Type.Object({
  input_path: Type.String({
    minLength: 1,
    maxLength: 2000,
    description: 'Print-ready HTML file path to export to PDF. Relative paths resolve from the current session cwd.',
  }),
  output_path: Type.Optional(Type.String({
    maxLength: 2000,
    description: 'Output PDF path. Defaults to input_path with .pdf extension in the same directory.',
  })),
  mode: Type.Optional(Type.Union([Type.Literal('document'), Type.Literal('image')], {
    description: 'PDF export mode. document keeps selectable/searchable PDF text. image creates an image-backed PDF that prioritizes matching the final preview. Default: document.',
  })),
  wait_ms: Type.Optional(Type.Integer({
    minimum: 0,
    maximum: 10000,
    description: 'Virtual time budget in milliseconds before printing. Default 1000. Use more if the HTML loads fonts/images/scripts slowly.',
  })),
  verify_pages: Type.Optional(Type.String({
    maxLength: 100,
    description: 'PDF pages to render back for visual verification. Default: 1. Examples: "1", "1-2".',
  })),
  preview_output_dir: Type.Optional(Type.String({
    maxLength: 2000,
    description: 'Optional directory to save final preview PNG pages for human/AI review. Relative paths resolve from the current session cwd.',
  })),
});

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveRuntimeWorkspacePath(inputPath: string, projectRoot?: string | null): string | null {
  if (inputPath !== '/workspace' && !inputPath.startsWith('/workspace/')) return null;
  if (!projectRoot) {
    throw new Error(`Cannot resolve Runtime Box path ${inputPath}: this tool run has no sessionProjectRoot.`);
  }

  const root = path.resolve(projectRoot);
  const suffix = inputPath.slice('/workspace'.length);
  const resolved = path.resolve(root, `.${suffix || ''}`);
  if (!isInside(root, resolved)) {
    throw new Error(`Runtime Box path escapes project root: ${inputPath}`);
  }
  return resolved;
}

export function resolvePdfExportPath(inputPath: string, cwd: string, projectRoot?: string | null): string {
  const runtimePath = resolveRuntimeWorkspacePath(inputPath, projectRoot);
  if (runtimePath) return runtimePath;

  if (path.isAbsolute(inputPath)) {
    return path.resolve(inputPath);
  }

  const effectiveCwd = resolveRuntimeWorkspacePath(cwd, projectRoot) ?? cwd;
  return path.resolve(effectiveCwd, inputPath);
}

function defaultOutputPath(inputPath: string): string {
  const ext = path.extname(inputPath);
  return path.join(path.dirname(inputPath), `${path.basename(inputPath, ext)}.pdf`);
}

function findPlaywrightChromium(): string | null {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), '.cache', 'ms-playwright'),
  ].filter((p): p is string => !!p && p !== '0');

  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      const candidates = readdirSync(root)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort((a, b) => Number(b.replace('chromium-', '')) - Number(a.replace('chromium-', '')))
        .flatMap((name) => [
          path.join(root, name, 'chrome-linux64', 'chrome'),
          path.join(root, name, 'chrome-linux', 'chrome'),
        ]);
      const found = candidates.find((candidate) => existsSync(candidate));
      if (found) return found;
    } catch {
      // Ignore unreadable browser cache dirs and keep looking at other candidates.
    }
  }
  return null;
}

export function isSnapChromiumShim(chromiumPath: string): boolean {
  if (chromiumPath === '/snap/bin/chromium') return true;
  try {
    const content = readFileSync(chromiumPath, 'utf8').slice(0, 4096);
    return content.includes('/snap/bin/chromium') || content.includes('snap install chromium');
  } catch {
    return false;
  }
}

export function findChromium(candidatesOverride?: Array<string | null | undefined>): string | null {
  const candidates = candidatesOverride ?? [
    process.env.CHROMIUM_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    // Playwright Chromium is no longer a default host PDF fallback. On customer
    // VMs Chrome-for-Testing can hang indefinitely in print-to-PDF even when DOM
    // rendering works. Operators can opt back in explicitly while debugging.
    process.env.PDF_EXPORT_ALLOW_PLAYWRIGHT_CHROMIUM === '1' ? findPlaywrightChromium() : null,
    // Snap Chromium is intentionally no longer a default fallback. Its profile
    // confinement workarounds contaminated non-snap PDF export and caused hangs
    // on self-hosted servers. Operators who explicitly need it can set CHROMIUM_PATH.
  ];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    if (isSnapChromiumShim(candidate) && process.env.CHROMIUM_PATH !== candidate) continue;
    return candidate;
  }
  return null;
}

export async function chromiumUserDataDir(): Promise<string> {
  // Always use an export-scoped profile. The old snap-era shared profile under
  // ~/snap/chromium/common created lock/cache contamination when the browser was
  // actually Playwright/system Chromium.
  const root = path.join(os.homedir(), '.cache', 'tower', 'pdf-export-profiles');
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, 'tower-pdf-export-'));
}

function formatChromiumArgsForError(args: string[]): string {
  return args
    .filter((arg) => !arg.startsWith('file://'))
    .map((arg) => arg.startsWith('--user-data-dir=') ? '--user-data-dir=<redacted>' : arg)
    .join(' ');
}

function chromiumProcessTempDir(): string {
  const dir = path.join(os.homedir(), '.cache', 'tower', 'chromium-tmp');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runChromium(args: string[], timeoutMs = Number(process.env.PDF_EXPORT_CHROMIUM_TIMEOUT_MS || 90000)): Promise<void> {
  return new Promise((resolve, reject) => {
    const chromium = findChromium();
    if (!chromium) {
      reject(new Error('Chromium not found. Install Playwright/system Chromium or set CHROMIUM_PATH to a non-snap Chromium binary.'));
      return;
    }
    const child = spawn(chromium, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TMPDIR: chromiumProcessTempDir() },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killedForTimeout = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      killedForTimeout = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 3000).unref();
    }, timeoutMs) : null;
    timer?.unref();

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (killedForTimeout) {
        finish(new Error([
          `Chromium PDF export timed out after ${timeoutMs}ms`,
          `Chromium: ${chromium}`,
          `Args: ${formatChromiumArgsForError(args)}`,
          stdout.trim(),
          stderr.trim(),
        ].filter(Boolean).join('\n')));
        return;
      }
      if (code !== 0) {
        finish(new Error([`Chromium exited ${code ?? signal}`, stdout.trim(), stderr.trim()].filter(Boolean).join('\n')));
        return;
      }
      finish();
    });
  });
}

function runExternalRenderer(command: string, args: string[], timeoutMs = Number(process.env.PDF_EXPORT_NIX_RENDERER_TIMEOUT_MS || 90000)): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killedForTimeout = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      killedForTimeout = true;
      child.kill('SIGTERM');
      setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 3000).unref();
    }, timeoutMs) : null;
    timer?.unref();

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (killedForTimeout) {
        finish(new Error(`Nix renderer timed out after ${timeoutMs}ms: ${command}`));
      } else if (code !== 0) {
        finish(new Error([`Nix renderer exited ${code ?? signal}`, stdout.trim(), stderr.trim()].filter(Boolean).join('\n')));
      } else {
        finish();
      }
    });
  });
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error([`${command} exited ${code}`, stdout.trim(), stderr.trim()].filter(Boolean).join('\n')));
        return;
      }
      resolve();
    });
  });
}

function runCommandCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error([`${command} exited ${code}`, stdout.trim(), stderr.trim()].filter(Boolean).join('\n')));
        return;
      }
      resolve(stdout);
    });
  });
}

async function extractPdfText(pdfPath: string): Promise<string> {
  return runCommandCapture('pdftotext', [pdfPath, '-']);
}

async function inspectPdfFonts(pdfPath: string): Promise<string> {
  return runCommandCapture('pdffonts', [pdfPath]);
}

interface PdfPreflightWarning {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  count: number;
}

interface PdfResidueFinding {
  code: string;
  count: number;
  message: string;
}

export interface PdfFontPostflightFinding {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  count: number;
}

interface PdfFontPostflightSummary {
  available: boolean;
  findings: PdfFontPostflightFinding[];
  rawOutput?: string;
  stats?: {
    totalFontRows: number;
    type3Rows: number;
    unnamedType3Rows: number;
    embeddedNamedRows: number;
    preferredKoreanFontRows: number;
  };
}

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function preflightHtmlForPdf(source: string): PdfPreflightWarning[] {
  const checks: Array<{ code: string; pattern: RegExp; severity?: 'warning' | 'error'; message: string }> = [
    { code: 'raw-mermaid-fence', pattern: /```\s*mermaid\b/gi, severity: 'error', message: 'HTML source에 Markdown Mermaid fence가 남아 있습니다. print-ready HTML로 변환한 뒤 export해야 합니다.' },
    { code: 'raw-chart-fence', pattern: /```\s*chart\b/gi, severity: 'error', message: 'HTML source에 Markdown chart fence가 남아 있습니다. chart를 HTML/SVG/canvas로 렌더한 뒤 export해야 합니다.' },
    { code: 'rgba', pattern: /rgba\s*\(/gi, message: '반투명 색상(rgba)은 PDF 뷰어별 합성 차이를 만들 수 있습니다.' },
    { code: 'opacity', pattern: /opacity\s*:/gi, message: 'opacity는 하위 요소 전체를 투명 처리해 PDF 뷰어별 차이를 만들 수 있습니다.' },
    { code: 'box-shadow', pattern: /box-shadow\s*:/gi, message: '큰 그림자는 문서용 PDF에서 뷰어별로 다르게 보일 수 있습니다.' },
    { code: 'filter', pattern: /(?<!backdrop-)filter\s*:/gi, message: 'CSS filter는 PDF 출력과 뷰어 호환성이 낮을 수 있습니다.' },
    { code: 'backdrop-filter', pattern: /backdrop-filter\s*:/gi, message: 'backdrop-filter는 PDF 출력에서 브라우저 화면과 다르게 보일 수 있습니다.' },
    { code: 'mix-blend-mode', pattern: /mix-blend-mode\s*:/gi, message: 'blend mode는 PDF viewer별 색상 차이를 만들 수 있습니다.' },
    { code: 'radial-gradient', pattern: /radial-gradient\s*\(/gi, message: '복합 gradient는 일부 PDF viewer에서 화면과 다르게 보일 수 있습니다.' },
    { code: 'absolute-transform', pattern: /position\s*:\s*absolute[\s\S]{0,240}transform\s*:/gi, message: 'absolute 배치와 transform을 섞은 복잡한 도식은 출력 경로별로 어긋날 수 있습니다. SVG 또는 image PDF를 권장합니다.' },
    { code: 'viewport-unit', pattern: /\b\d+(?:\.\d+)?v[wh]\b/gi, message: 'vw/vh 기반 크기는 PDF page size와 다르게 해석될 수 있습니다.' },
    { code: 'external-font', pattern: /@font-face[\s\S]{0,500}https?:\/\//gi, message: '외부 웹폰트는 출력 시점 로딩 상태에 따라 줄바꿈이 달라질 수 있습니다.' },
  ];

  const warnings: PdfPreflightWarning[] = [];
  for (const check of checks) {
    const count = countMatches(source, check.pattern);
    if (count > 0) {
      const severity = check.severity ?? 'warning';
      warnings.push({ code: check.code, severity, message: `${check.message} 감지 수: ${count}`, count });
    }
  }
  return warnings;
}

function assertNoFatalPreflightWarnings(warnings: PdfPreflightWarning[]): void {
  const fatal = warnings.filter((w) => w.severity === 'error');
  if (fatal.length === 0) return;
  throw new Error([
    'pdf_export preflight failed: source HTML still contains raw visual/code fences.',
    ...fatal.map((w) => `- ${w.code}: ${w.message}`),
  ].join('\n'));
}

function detectRawVisualResidues(text: string): PdfResidueFinding[] {
  const checks: Array<{ code: string; pattern: RegExp; message: string }> = [
    { code: 'raw-mermaid-fence', pattern: /```\s*mermaid\b/gi, message: 'Mermaid Markdown fence is visible in the exported PDF.' },
    { code: 'raw-chart-fence', pattern: /```\s*chart\b/gi, message: 'Chart Markdown fence is visible in the exported PDF.' },
    { code: 'mermaid-flowchart-source', pattern: /\b(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b/gi, message: 'Mermaid flowchart source text is visible in the exported PDF.' },
    { code: 'mermaid-diagram-source', pattern: /\b(?:sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie\s+title|mindmap)\b/gi, message: 'Mermaid diagram source text is visible in the exported PDF.' },
    { code: 'chart-json-source', pattern: /"(?:type|xKey|yKey|data)"\s*:\s*(?:"(?:bar|line|area|pie|scatter|radar|composed)"|\[|\{)/gi, message: 'Chart JSON source appears to be visible in the exported PDF.' },
  ];
  const findings: PdfResidueFinding[] = [];
  for (const check of checks) {
    const count = countMatches(text, check.pattern);
    if (count > 0) findings.push({ code: check.code, count, message: check.message });
  }
  return findings;
}

function assertNoRawVisualResidues(text: string): void {
  const findings = detectRawVisualResidues(text);
  if (findings.length === 0) return;
  throw new Error([
    'pdf_export verification failed: raw Mermaid/chart source appears in the exported PDF text.',
    ...findings.map((f) => `- ${f.code}: ${f.message} count=${f.count}`),
    'Fix the HTML so visuals render before export, then run pdf_export again.',
  ].join('\n'));
}

function preflightVisualRisk(warnings: PdfPreflightWarning[]): 'none' | 'minor' | 'high' {
  if (warnings.length === 0) return 'none';
  const highSignalCodes = new Set(['filter', 'backdrop-filter', 'mix-blend-mode', 'radial-gradient', 'absolute-transform']);
  if (warnings.some((w) => highSignalCodes.has(w.code))) return 'high';
  const total = warnings.reduce((sum, w) => sum + w.count, 0);
  if (total >= 8) return 'high';
  if ((warnings.find((w) => w.code === 'box-shadow')?.count ?? 0) >= 3) return 'high';
  return 'minor';
}

function preflightOutputLines(warnings: PdfPreflightWarning[], mode: 'document' | 'image'): string[] {
  if (warnings.length === 0) return ['[Preflight compatibility advisories: none]'];
  const risk = preflightVisualRisk(warnings);
  const lines = [
    '[Preflight compatibility advisories]',
    ...warnings.map((w) => `- ${w.code}: ${w.message}`),
  ];
  if (risk === 'high' && mode === 'document') {
    lines.push(
      '[Preflight recommendation]',
      '- 시각 효과가 많아 document PDF는 Mac Preview 등 일부 뷰어에서 다르게 보일 수 있습니다.',
      '- 최종 전달용이면 mode=image PDF도 함께 만드는 것을 권장합니다.',
    );
  } else if (risk === 'high' && mode === 'image') {
    lines.push(
      '[Preflight recommendation]',
      '- 시각 효과가 많은 HTML입니다. 최종 화면 고정을 중시한다면 mode=image 선택이 적절합니다.',
    );
  } else {
    lines.push(
      '[Preflight recommendation]',
      '- 경미한 호환성 advisory입니다. document PDF로 진행해도 대체로 무방합니다.',
    );
  }
  return lines;
}

export function analyzePdfFontPostflight(pdffontsOutput: string, mode: 'document' | 'image'): PdfFontPostflightSummary {
  const lines = pdffontsOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rows = lines.filter((line) => !line.startsWith('name ') && !line.startsWith('---'));
  const preferredKoreanFontPattern = /(?:Pretendard|NotoSansCJK|Noto Sans CJK|NotoSansKR|Noto Sans KR|Nanum|Malgun|AppleSDGothic|Apple SD Gothic)/i;
  const type3Rows = rows.filter((line) => /\bType\s+3\b/i.test(line));
  const unnamedType3Rows = type3Rows.filter((line) => /^\[none\]\s+Type\s+3\b/i.test(line));
  const embeddedNamedRows = rows.filter((line) => !/^\[none\]\b/i.test(line) && /\syes\s+(?:yes|no)\s+(?:yes|no)\s+\d+\s+\d+\s*$/i.test(line));
  const preferredKoreanFontRows = rows.filter((line) => preferredKoreanFontPattern.test(line));
  const findings: PdfFontPostflightFinding[] = [];

  if (mode === 'image') {
    return {
      available: true,
      findings,
      rawOutput: pdffontsOutput,
      stats: {
        totalFontRows: rows.length,
        type3Rows: type3Rows.length,
        unnamedType3Rows: unnamedType3Rows.length,
        embeddedNamedRows: embeddedNamedRows.length,
        preferredKoreanFontRows: preferredKoreanFontRows.length,
      },
    };
  }

  if (rows.length > 0 && unnamedType3Rows.length >= 8 && unnamedType3Rows.length / rows.length >= 0.5) {
    findings.push({
      code: 'unnamed-type3-fonts',
      severity: 'warning',
      count: unnamedType3Rows.length,
      message: `PDF에 이름 없는 Type 3 폰트가 ${unnamedType3Rows.length}개 감지됐습니다. 일부 뷰어/모바일/메신저 미리보기에서 한글 글꼴이 다르게 보일 수 있습니다. 외부 공유용이면 mode=image 재출력을 권장합니다.`,
    });
  }

  if (rows.length > 0 && preferredKoreanFontRows.length === 0 && unnamedType3Rows.length > 0) {
    findings.push({
      code: 'missing-named-korean-font-embed',
      severity: 'warning',
      count: 1,
      message: 'PDF 폰트 테이블에서 Pretendard/Noto/Nanum 계열 이름이 보이지 않습니다. 시스템 폰트가 설치되어 있어도 Chromium PDF 출력이 glyph 기반 Type 3 경로로 떨어졌을 수 있습니다.',
    });
  }

  return {
    available: true,
    findings,
    rawOutput: pdffontsOutput,
    stats: {
      totalFontRows: rows.length,
      type3Rows: type3Rows.length,
      unnamedType3Rows: unnamedType3Rows.length,
      embeddedNamedRows: embeddedNamedRows.length,
      preferredKoreanFontRows: preferredKoreanFontRows.length,
    },
  };
}

function fontPostflightOutputLines(summary: PdfFontPostflightSummary): string[] {
  if (!summary.available) return ['[Font postflight: unavailable — pdffonts not found or failed]'];
  const stats = summary.stats;
  const statLine = stats
    ? `[Font postflight: total=${stats.totalFontRows}, type3=${stats.type3Rows}, unnamedType3=${stats.unnamedType3Rows}, preferredKoreanNamed=${stats.preferredKoreanFontRows}]`
    : '[Font postflight: available]';
  if (summary.findings.length === 0) return [statLine, '[Font postflight advisories: none]'];
  return [
    statLine,
    '[Font postflight advisories]',
    ...summary.findings.map((f) => `- ${f.code}: ${f.message}`),
  ];
}

async function renderPdfPagesToPng(args: {
  pdfPath: string;
  outputDir: string;
  dpi: number;
}): Promise<string[]> {
  await fs.mkdir(args.outputDir, { recursive: true });
  const prefix = path.join(args.outputDir, 'page');
  await runCommand('pdftoppm', ['-png', '-r', String(args.dpi), args.pdfPath, prefix]);
  const entries = await fs.readdir(args.outputDir);
  return entries
    .filter((name) => /^page-\d+\.png$/.test(name))
    .sort()
    .map((name) => path.join(args.outputDir, name));
}

async function buildImagePdfFromPngs(args: {
  pngPaths: string[];
  outputPath: string;
  dpi: number;
}): Promise<void> {
  const doc = await PDFDocument.create();
  for (const pngPath of args.pngPaths) {
    const pngBytes = await fs.readFile(pngPath);
    const png = await doc.embedPng(pngBytes);
    // pdftoppm renders at `dpi` pixels per inch, while PDF page units are
    // points (72 per inch). Convert pixels back to points so image PDFs keep
    // the original document page size instead of becoming huge pixel-sized
    // pages that look zoomed/cropped in viewers.
    const widthPt = png.width * 72 / args.dpi;
    const heightPt = png.height * 72 / args.dpi;
    const page = doc.addPage([widthPt, heightPt]);
    page.drawImage(png, { x: 0, y: 0, width: widthPt, height: heightPt });
  }
  const pdfBytes = await doc.save();
  await fs.writeFile(args.outputPath, pdfBytes);
}

async function copyPreviewImages(args: {
  pngPaths: string[];
  previewOutputDir?: string;
}): Promise<string[]> {
  if (!args.previewOutputDir) return [];
  await fs.mkdir(args.previewOutputDir, { recursive: true });
  const copied: string[] = [];
  for (let index = 0; index < args.pngPaths.length; index += 1) {
    const dest = path.join(args.previewOutputDir, `page-${String(index + 1).padStart(2, '0')}.png`);
    await fs.copyFile(args.pngPaths[index], dest);
    copied.push(dest);
  }
  return copied;
}

async function exportHtmlToPdfWithSystemChromium(args: {
  inputPath: string;
  outputPath: string;
  waitMs: number;
}): Promise<void> {
  const userDataDir = await chromiumUserDataDir();
  const fileUrl = pathToFileURL(args.inputPath).toString();
  try {
    const chromiumArgs = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-domain-reliability',
      '--metrics-recording-only',
      '--safebrowsing-disable-auto-update',
      '--run-all-compositor-stages-before-draw',
      `--user-data-dir=${userDataDir}`,
      `--virtual-time-budget=${args.waitMs}`,
      '--no-pdf-header-footer',
      '--print-to-pdf-no-header',
      `--print-to-pdf=${args.outputPath}`,
      fileUrl,
    ];
    await runChromium(chromiumArgs);
  } finally {
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
}

function logPdfRendererEvent(result: PdfExportRendererResult): void {
  console.info(`[pdf-export-renderer] ${JSON.stringify({
    event: 'pdf_export_renderer_complete',
    requested: result.requested,
    used: result.used,
    fallback: result.fallback,
    fallbackReason: result.fallbackReason,
    nixDurationMs: result.nixDurationMs,
    systemDurationMs: result.systemDurationMs,
    totalDurationMs: result.totalDurationMs,
  })}`);
}

async function assertNonEmptyPdf(outputPath: string, renderer: PdfExportRendererMode): Promise<void> {
  const st = await fs.stat(outputPath);
  if (st.size <= 0) throw new Error(`${renderer} renderer created an empty PDF.`);
}

export async function exportHtmlToPdf(args: {
  inputPath: string;
  outputPath: string;
  waitMs: number;
}): Promise<PdfExportRendererResult> {
  const totalStartedAt = Date.now();
  await fs.access(args.inputPath);
  await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
  const renderer = resolvePdfExportRendererConfig();
  let nixDurationMs: number | undefined;
  let systemDurationMs: number | undefined;
  let fallbackReason: string | undefined;

  if (renderer.mode === 'nix') {
    const nixStartedAt = Date.now();
    try {
      if (!renderer.nixRendererBin) {
        throw new Error('NIX_RENDERER_BIN must be an absolute path when PDF_EXPORT_RENDERER_MODE=nix.');
      }
      await fs.access(renderer.nixRendererBin);
      await runExternalRenderer(renderer.nixRendererBin, [
        args.inputPath,
        args.outputPath,
        '--wait-ms',
        String(args.waitMs),
      ]);
      await assertNonEmptyPdf(args.outputPath, 'nix');
      nixDurationMs = Date.now() - nixStartedAt;
      const result: PdfExportRendererResult = {
        requested: 'nix',
        used: 'nix',
        fallback: false,
        nixDurationMs,
        totalDurationMs: Date.now() - totalStartedAt,
      };
      logPdfRendererEvent(result);
      return result;
    } catch (error) {
      nixDurationMs = Date.now() - nixStartedAt;
      fallbackReason = (error as Error).message.slice(0, 2000);
      await fs.rm(args.outputPath, { force: true });
    }
  }

  const systemStartedAt = Date.now();
  await exportHtmlToPdfWithSystemChromium(args);
  await assertNonEmptyPdf(args.outputPath, 'system');
  systemDurationMs = Date.now() - systemStartedAt;
  const result: PdfExportRendererResult = {
    requested: renderer.mode,
    used: 'system',
    fallback: renderer.mode === 'nix',
    fallbackReason,
    nixDurationMs,
    systemDurationMs,
    totalDurationMs: Date.now() - totalStartedAt,
  };
  logPdfRendererEvent(result);
  return result;
}

async function exportHtmlToImagePdf(args: {
  inputPath: string;
  outputPath: string;
  waitMs: number;
  previewOutputDir?: string;
}): Promise<{ previewPaths: string[]; intermediatePdfPath: string; renderer: PdfExportRendererResult }> {
  // Keep intermediate files under the HTML work folder, not final/. Snap
  // Chromium can be unable to read/write arbitrary /tmp paths in the Tower VM
  // environment, and a crash should not leave scratch files beside deliverables.
  await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(path.dirname(args.inputPath), '.tower-pdf-image-'));
  try {
    const intermediatePdfPath = path.join(tempDir, 'document.pdf');
    const renderer = await exportHtmlToPdf({ inputPath: args.inputPath, outputPath: intermediatePdfPath, waitMs: args.waitMs });
    const pngDir = path.join(tempDir, 'preview');
    const pngPaths = await renderPdfPagesToPng({ pdfPath: intermediatePdfPath, outputDir: pngDir, dpi: 200 });
    if (pngPaths.length === 0) throw new Error('No preview pages were rendered for image PDF export.');
    await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
    await buildImagePdfFromPngs({ pngPaths, outputPath: args.outputPath, dpi: 200 });
    const previewPaths = await copyPreviewImages({ pngPaths, previewOutputDir: args.previewOutputDir });
    const st = await fs.stat(args.outputPath);
    if (st.size <= 0) throw new Error('Created an empty image PDF.');
    return { previewPaths, intermediatePdfPath, renderer };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export function createPdfExportTool(ctx: PdfExportContext): ToolDefinition {
  return {
    name: 'pdf_export',
    label: 'Export PDF',
    description: [
      'Export print-ready HTML to a final PDF using the Tower harness PDF export pipeline.',
      'Use this when the user asks for a PDF artifact, not as a “maybe” fallback.',
      'Supports document PDFs with selectable text and image PDFs that prioritize matching the final preview.',
      'After export, the tool renders verification pages through internal cache and returns them to LLM vision.',
    ].join(' '),
    promptSnippet: 'Export print-ready HTML to document/image PDF with Chromium and return visual verification pages.',
    promptGuidelines: [
      'Use pdf_export when the requested final artifact is a PDF and the source is print-ready HTML.',
      'For user-facing reports, proposals, printable docs, and slide PDFs, prefer pdf_export as the safe default even if the user casually asks for HTML-only/quick draft, unless they clearly opt out or are managing rendering code themselves.',
      'Do not downgrade a PDF request to HTML-only; use this harness contract or report the concrete export failure.',
      'Use mode="document" by default; use mode="image" when visual fidelity matters more than selectable text.',
      'After pdf_export, inspect returned verification image(s) before reporting success, especially checking that Mermaid/chart/dynamic content rendered instead of leaving raw code visible.',
      'For detailed print-ready HTML, preflight, mode, and verification-loop rules, use runtime_guide_read with name="pdf-export".',
    ],
    parameters: PdfExportParams,
    async execute(_toolCallId: string, params: {
      input_path: string;
      output_path?: string;
      mode?: 'document' | 'image';
      wait_ms?: number;
      verify_pages?: string;
      preview_output_dir?: string;
    }): Promise<AgentToolResult<any>> {
      const inputPath = resolvePdfExportPath(params.input_path, ctx.cwd, ctx.projectRoot);
      const outputPath = params.output_path ? resolvePdfExportPath(params.output_path, ctx.cwd, ctx.projectRoot) : defaultOutputPath(inputPath);
      const mode = params.mode ?? 'document';
      const waitMs = params.wait_ms ?? 1000;
      const verifyPages = params.verify_pages || '1';
      const previewOutputDir = params.preview_output_dir ? resolvePdfExportPath(params.preview_output_dir, ctx.cwd, ctx.projectRoot) : undefined;

      try {
        if (!inputPath.toLowerCase().endsWith('.html') && !inputPath.toLowerCase().endsWith('.htm')) {
          throw new Error('pdf_export currently accepts print-ready HTML files (.html/.htm).');
        }
        if (!outputPath.toLowerCase().endsWith('.pdf')) {
          throw new Error('output_path must end with .pdf.');
        }

        const source = await fs.readFile(inputPath, 'utf8');
        const warnings = preflightHtmlForPdf(source);
        assertNoFatalPreflightWarnings(warnings);
        let previewPaths: string[] = [];
        let renderer: PdfExportRendererResult;
        if (mode === 'image') {
          const imageResult = await exportHtmlToImagePdf({ inputPath, outputPath, waitMs, previewOutputDir });
          previewPaths = imageResult.previewPaths;
          renderer = imageResult.renderer;
        } else {
          renderer = await exportHtmlToPdf({ inputPath, outputPath, waitMs });
        }
        const rendered = await renderPdfToCachedImages({
          cwd: path.dirname(outputPath),
          path: outputPath,
          pages: verifyPages,
          dpi: 144,
        });
        try {
          const extractedText = await extractPdfText(outputPath);
          assertNoRawVisualResidues(extractedText);
        } catch (error: any) {
          if (error?.code === 'ENOENT') {
            // pdftotext is a best-effort verification helper. Visual preview still
            // returns to the model for human/AI inspection on minimal systems.
          } else {
            throw error;
          }
        }
        let fontPostflight: PdfFontPostflightSummary = { available: false, findings: [] };
        try {
          fontPostflight = analyzePdfFontPostflight(await inspectPdfFonts(outputPath), mode);
        } catch (error: any) {
          if (error?.code !== 'ENOENT') {
            fontPostflight = {
              available: false,
              findings: [{
                code: 'pdffonts-failed',
                severity: 'warning',
                count: 1,
                message: `pdffonts 실행에 실패해 PDF 폰트 테이블을 확인하지 못했습니다: ${error?.message || error}`,
              }],
            };
          }
        }
        const stat = await fs.stat(outputPath);
        const warningLines = preflightOutputLines(warnings, mode);
        const fontLines = fontPostflightOutputLines(fontPostflight);
        const previewLines = previewPaths.length > 0
          ? ['[Final preview images]', ...previewPaths.map((p) => `- ${p}`)]
          : [];
        const content: AgentToolResult<any>['content'] = [{
          type: 'text',
          text: [
            `Exported PDF artifact [application/pdf; mode=${mode}]`,
            `[Input HTML: ${inputPath}]`,
            `[Output PDF: ${outputPath}]`,
            `[Size: ${stat.size} bytes]`,
            `[Renderer: requested=${renderer.requested}; used=${renderer.used}; fallback=${renderer.fallback ? 'yes' : 'no'}]`,
            ...(renderer.fallbackReason ? [`[Renderer fallback reason: ${renderer.fallbackReason}]`] : []),
            `[Verification pages: ${rendered.pages.join(', ')} of ${rendered.pageCount}]`,
            ...warningLines,
            ...fontLines,
            ...previewLines,
          ].join('\n'),
        } as any, ...(await pdfViewResultContent(rendered))];

        return {
          content,
          details: {
            pdfExported: true,
            mode,
            inputPath,
            outputPath,
            size: stat.size,
            verificationPages: rendered.pages,
            cacheDir: rendered.cacheDir,
            preflightWarnings: warnings,
            renderer,
            fontPostflight,
            previewPaths,
          },
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `[pdf_export error] ${(error as Error).message}` } as any],
          details: { pdfExported: false, error: (error as Error).message, inputPath, outputPath },
          isError: true,
        } as any;
      }
    },
  } as ToolDefinition;
}
