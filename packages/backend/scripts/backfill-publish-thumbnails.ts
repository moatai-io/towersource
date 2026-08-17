#!/usr/bin/env tsx
/**
 * Backfill Publishing Hub thumbnails for existing local static sites.
 *
 * Usage:
 *   npx tsx packages/backend/scripts/backfill-publish-thumbnails.ts [--force] [--limit N] [--slug slug]
 *
 * Generates thumbnails from the actual published page / explicit meta images.
 * Does not use image generation.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config.js';
import { generatePublishThumbnail, thumbnailUrlForSlug } from '../services/publishing/thumbnail-generator.js';

type Access = 'public' | 'unlisted' | 'private' | 'internal';
type ThumbnailStatus = 'pending' | 'ready' | 'failed' | 'skipped';

interface ManifestSite {
  name: string;
  slug?: string;
  description?: string;
  access?: Access | string;
  deploy_target?: string;
  external_url?: string;
  archived?: boolean;
  thumbnail_url?: string;
  thumbnail_path?: string;
  thumbnail_generated_at?: string;
  thumbnail_status?: ThumbnailStatus;
  thumbnail_error?: string;
  [key: string]: unknown;
}

interface Manifest {
  version?: number;
  domain?: string;
  updated_at?: string;
  sites: ManifestSite[];
  apps?: unknown[];
  [key: string]: unknown;
}

const MANIFEST_PATH = path.join(config.workspaceRoot, 'published', 'manifest.json');

function parseArgs(argv: string[]) {
  const opts = { force: false, limit: Infinity, slug: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--limit') opts.limit = Math.max(1, Number(argv[++i] || '0') || 1);
    else if (a.startsWith('--limit=')) opts.limit = Math.max(1, Number(a.slice('--limit='.length)) || 1);
    else if (a === '--slug') opts.slug = argv[++i] || '';
    else if (a.startsWith('--slug=')) opts.slug = a.slice('--slug='.length);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: npx tsx packages/backend/scripts/backfill-publish-thumbnails.ts [--force] [--limit N] [--slug slug]');
      process.exit(0);
    }
  }
  return opts;
}

function localPublishedUrl(slug: string): string | undefined {
  if (!config.publicUrl) return undefined;
  const u = new URL(config.publicUrl);
  return `${u.protocol}//${slug}.${u.host}/`;
}

async function readManifest(): Promise<Manifest> {
  const raw = await fs.readFile(MANIFEST_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.sites)) parsed.sites = [];
  return parsed;
}

async function writeManifest(manifest: Manifest): Promise<void> {
  manifest.updated_at = new Date().toISOString();
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

function shouldProcess(site: ManifestSite, opts: { force: boolean; slug: string }): boolean {
  const slug = site.slug || site.name;
  if (opts.slug && opts.slug !== slug && opts.slug !== site.name) return false;
  if (site.archived) return false;
  if (site.deploy_target && site.deploy_target !== 'local') return false;
  if (opts.force) return true;
  return site.thumbnail_status !== 'ready' || !site.thumbnail_url;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = await readManifest();
  const targets = manifest.sites.filter((s) => shouldProcess(s, opts)).slice(0, opts.limit);
  console.log(`[publish-thumbnails] manifest=${MANIFEST_PATH}`);
  console.log(`[publish-thumbnails] targets=${targets.length} force=${opts.force} slug=${opts.slug || '(all)'}`);

  let ready = 0;
  let failed = 0;
  let skipped = 0;

  for (const site of targets) {
    const slug = site.slug || site.name;
    const url = site.external_url || localPublishedUrl(slug);
    if (!url) {
      site.thumbnail_status = 'skipped';
      site.thumbnail_error = 'Missing URL';
      skipped++;
      console.log(`- ${slug}: skipped (missing URL)`);
      continue;
    }

    site.thumbnail_status = 'pending';
    site.thumbnail_url = thumbnailUrlForSlug(slug);
    delete site.thumbnail_error;
    await writeManifest(manifest);

    console.log(`- ${slug}: capturing ${url}`);
    const result = await generatePublishThumbnail({ slug, url });
    site.thumbnail_status = result.status;
    if (result.thumbnailUrl) site.thumbnail_url = result.thumbnailUrl;
    if (result.thumbnailPath) site.thumbnail_path = result.thumbnailPath;
    if (result.generatedAt) site.thumbnail_generated_at = result.generatedAt;
    if (result.error) site.thumbnail_error = result.error.slice(0, 500);
    else delete site.thumbnail_error;
    await writeManifest(manifest);

    if (result.status === 'ready') ready++;
    else if (result.status === 'failed') failed++;
    else skipped++;
    console.log(`  -> ${result.status}${result.error ? `: ${result.error}` : ''}`);
  }

  console.log(`[publish-thumbnails] done ready=${ready} failed=${failed} skipped=${skipped}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[publish-thumbnails] fatal: ${err?.stack || err?.message || String(err)}`);
  process.exit(1);
});
