/**
 * thumbnail-generator.ts — publishing thumbnail generation.
 *
 * Owns: best-effort thumbnails for Publishing Hub cards. The source of truth is
 * the actual published page, not AI-generated artwork.
 * Public API: generatePublishThumbnail({ slug, url }).
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { config } from '../../config.js';

export type ThumbnailStatus = 'pending' | 'ready' | 'failed' | 'skipped';

export interface ThumbnailResult {
  status: ThumbnailStatus;
  thumbnailPath?: string;
  thumbnailUrl?: string;
  generatedAt?: string;
  error?: string;
}

const THUMBNAIL_WIDTH = 1200;
const THUMBNAIL_HEIGHT = 675;
const TIMEOUT_MS = 12_000;

export const THUMBNAILS_DIR = () => path.join(config.workspaceRoot, 'published', 'thumbnails');

export function thumbnailUrlForSlug(slug: string): string | undefined {
  if (!config.publicUrl) return undefined;
  const base = config.publicUrl.replace(/\/$/, '');
  return `${base}/published-thumbnails/${encodeURIComponent(slug)}.png`;
}

function findChromium(): string | null {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/snap/bin/chromium',
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) || null;
}

async function chromiumUserDataDir(): Promise<string> {
  const snapCommon = path.join(os.homedir(), 'snap', 'chromium', 'common');
  if (existsSync(snapCommon)) {
    const dir = path.join(snapCommon, 'tower-publish-thumbnail-profile');
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }
  const dir = path.join(os.tmpdir(), 'tower-publish-thumbnail-profile');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function extractPreferredImageUrl(pageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(pageUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 128_000);
    const patterns = [
      /<meta\s+[^>]*(?:name|property)=["']tower:thumbnail["'][^>]*content=["']([^"']+)["'][^>]*>/i,
      /<meta\s+[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["']tower:thumbnail["'][^>]*>/i,
      /<meta\s+[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i,
      /<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["'][^>]*>/i,
      /<meta\s+[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["'][^>]*>/i,
      /<meta\s+[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["'][^>]*>/i,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      const raw = m?.[1]?.trim();
      if (!raw || raw.startsWith('data:')) continue;
      return new URL(raw, pageUrl).toString();
    }
    return null;
  } catch {
    return null;
  }
}

function runChromiumScreenshot(targetUrl: string, outputPath: string): Promise<void> {
  return new Promise(async (resolve, reject) => {
    const chromium = findChromium();
    if (!chromium) {
      reject(new Error('Chromium not found. Install chromium/chromium-browser or set CHROMIUM_PATH.'));
      return;
    }
    const userDataDir = await chromiumUserDataDir();
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--user-data-dir=${userDataDir}`,
      `--window-size=${THUMBNAIL_WIDTH},${THUMBNAIL_HEIGHT}`,
      `--screenshot=${outputPath}`,
      targetUrl,
    ];
    const child = spawn(chromium, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Chromium thumbnail capture timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Chromium thumbnail capture failed (${code}): ${stderr.slice(-500)}`));
        return;
      }
      try {
        const st = await fs.stat(outputPath);
        if (st.size <= 0) throw new Error('Chromium created an empty thumbnail.');
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

export async function generatePublishThumbnail(args: {
  slug: string;
  url?: string;
}): Promise<ThumbnailResult> {
  if (!args.slug || !args.url) return { status: 'skipped', error: 'Missing slug or URL' };
  const safeSlug = args.slug.replace(/[^a-zA-Z0-9_-]/g, '-');
  const outputPath = path.join(THUMBNAILS_DIR(), `${safeSlug}.png`);
  try {
    await fs.mkdir(THUMBNAILS_DIR(), { recursive: true });
    const preferred = await extractPreferredImageUrl(args.url);
    await runChromiumScreenshot(preferred || args.url, outputPath);
    return {
      status: 'ready',
      thumbnailPath: outputPath,
      thumbnailUrl: thumbnailUrlForSlug(safeSlug),
      generatedAt: new Date().toISOString(),
    };
  } catch (err: any) {
    return {
      status: 'failed',
      thumbnailPath: outputPath,
      thumbnailUrl: thumbnailUrlForSlug(safeSlug),
      error: err?.message || String(err),
    };
  }
}

export function generatePublishThumbnailInBackground(args: { slug: string; url?: string }, onDone: (result: ThumbnailResult) => void | Promise<void>): void {
  void generatePublishThumbnail(args)
    .then((result) => onDone(result))
    .catch((err) => onDone({ status: 'failed', error: err?.message || String(err) }));
}
