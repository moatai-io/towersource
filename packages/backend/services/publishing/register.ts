/**
 * Owns: idempotent manifest entry creation + project backfill for published sites.
 * Public API: registerSiteInManifest(slug, project?) — used by both the
 *   PostToolUse hook (realtime) and the periodic reconciler (safety net).
 * See README.md for layer overview.
 */
import fs from 'fs/promises';
import path from 'path';
import { config } from '../../config.js';

const PUBLISHED_DIR = () => path.join(config.workspaceRoot, 'published');
const MANIFEST_PATH = () => path.join(PUBLISHED_DIR(), 'manifest.json');
const SITES_DIR = () => path.join(PUBLISHED_DIR(), 'sites');

interface ManifestSite {
  name: string;
  slug?: string;
  description?: string;
  access: string;
  created_at: string;
  project?: string;
  archived?: boolean;
  tags?: string[];
  [key: string]: unknown;
}

interface Manifest {
  version: number;
  domain: string;
  updated_at: string;
  sites: ManifestSite[];
  apps: unknown[];
  extra_locations?: unknown[];
}

async function readManifest(): Promise<Manifest> {
  try {
    const raw = await fs.readFile(MANIFEST_PATH(), 'utf-8');
    const m = JSON.parse(raw);
    if (!Array.isArray(m.sites)) m.sites = [];
    if (!Array.isArray(m.apps)) m.apps = [];
    return m;
  } catch {
    return {
      version: 1,
      domain: '',
      updated_at: new Date().toISOString(),
      sites: [],
      apps: [],
    };
  }
}

async function writeManifest(m: Manifest): Promise<void> {
  m.updated_at = new Date().toISOString();
  await fs.mkdir(PUBLISHED_DIR(), { recursive: true });
  await fs.writeFile(MANIFEST_PATH(), JSON.stringify(m, null, 2));
}

/**
 * Extract `<project>` from a path containing `workspace/projects/<project>/...`.
 * Returns undefined when the path doesn't match. Used by the hook to derive
 * project from cwd or the touched file path.
 */
export function deriveProjectFromPath(p: string | null | undefined): string | undefined {
  if (!p) return undefined;
  const m = p.match(/[\\/]workspace[\\/]projects[\\/]([^\\/]+)/);
  return m ? m[1] : undefined;
}

/**
 * Slug is valid if it's lowercase alphanumeric + hyphens, doesn't start with
 * dot/dash. Filters out dotfiles, robots.txt, and arbitrary garbage so the
 * hook never registers non-site entries.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
export function isValidSlug(slug: string | undefined | null): slug is string {
  return !!slug && SLUG_RE.test(slug);
}

/**
 * Idempotent. Three outcomes:
 *  - already in manifest with project → no-op
 *  - already in manifest without project, project arg given → fill it
 *  - not in manifest → promote (only if disk folder exists)
 *
 * Never overwrites an explicit project the user already set — manifest is
 * source of truth for user intent. Only fills empty values.
 *
 * Safe to call concurrently for the same slug; race ends in last-write-wins
 * but final state is identical content. Heavy contention (>10 calls/sec on
 * same slug) would hit fs ordering issues, but real publishing patterns
 * never approach this rate.
 */
export async function registerSiteInManifest(
  slug: string,
  project?: string,
): Promise<{ ok: boolean; action: 'noop' | 'filled' | 'promoted' | 'not-on-disk' }> {
  if (!isValidSlug(slug)) return { ok: false, action: 'noop' };

  const manifest = await readManifest();
  const idx = manifest.sites.findIndex(s => s.name === slug || s.slug === slug);

  if (idx >= 0) {
    // Already in manifest. Fill project iff empty + arg given.
    const existing = manifest.sites[idx];
    if (!existing.project && project) {
      existing.project = project;
      await writeManifest(manifest);
      return { ok: true, action: 'filled' };
    }
    return { ok: true, action: 'noop' };
  }

  // Not in manifest. Promote only if disk folder actually exists — avoids
  // racing into manifest before file is written or for transient temp paths.
  const livePath = path.join(SITES_DIR(), slug);
  let createdAt = new Date().toISOString();
  try {
    const lst = await fs.lstat(livePath);
    createdAt = lst.mtime.toISOString();
  } catch {
    // Folder not on disk yet (Write fired but mkdir hasn't completed?
    // Or path was a temp file outside the slug). Skip — reconciler will
    // catch it later if the folder ends up real.
    return { ok: false, action: 'not-on-disk' };
  }

  manifest.sites.push({
    name: slug,
    slug,
    description: '',
    access: 'unlisted',  // matches getMergedSites synth default
    created_at: createdAt,
    project: project || undefined,
  });
  await writeManifest(manifest);
  return { ok: true, action: 'promoted' };
}

/**
 * Returns the slug if `absPath` is inside `published/sites/<slug>/...`,
 * otherwise null. Slug is the first path segment under sites/.
 */
export function siteSlugFromPath(absPath: string | undefined | null): string | null {
  if (!absPath) return null;
  const sitesPrefix = SITES_DIR() + path.sep;
  if (!absPath.startsWith(sitesPrefix)) return null;
  const rest = absPath.slice(sitesPrefix.length);
  const slug = rest.split(path.sep)[0];
  return isValidSlug(slug) ? slug : null;
}
