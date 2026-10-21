import { copyStaticPublication } from './static-publish-files.js';
import { atDeployStage } from './deploy-error.js';
/**
 * Deploy Engine — Cloudflare Pages + Azure Container Apps
 *
 * Analyzes code type and deploys to the appropriate platform:
 * - Static sites (HTML/CSS/JS only) → Cloudflare Pages
 * - Dynamic apps (server code)      → Azure Container Apps
 */
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { config } from '../../config.js';
import {publishedSiteUrl} from '../publishing/published-url.js';
import { generatePublishThumbnailInBackground, thumbnailUrlForSlug, type ThumbnailStatus, type ThumbnailResult } from '../publishing/thumbnail-generator.js';

const execFileAsync = promisify(execFile);

// ── Types ──

// 'local' — 외부로 배포하지 않고 디스크(workspace/published/sites/<slug>/) 에만 두고
//   wildcard 서브도메인(self-hosted VM) 또는 /sites/<slug>/ path(full server)로 nginx가 직접 서빙.
//   2026-04-25 부터 static 사이트의 default. 외부 CDN/공개가 필요할 때만 'cloudflare-pages' 명시.
//   결정: workspace/decisions/2026-04-23-publishing-visibility-redesign.md (i)
export type DeployTarget = 'local' | 'cloudflare-pages' | 'azure-container-apps';
export type DeployStatus = 'pending' | 'building' | 'deploying' | 'live' | 'failed';

export interface DeployResult {
  success: boolean;
  target: DeployTarget;
  url?: string;
  slug?: string;           // URL/folder slug for local static publishes
  error?: string;
  duration?: number;       // ms
  detectedType: 'static' | 'dynamic';
}

// 4-tier visibility — see workspace/decisions/2026-04-23-publishing-visibility-redesign.md
export type Access = 'public' | 'unlisted' | 'private' | 'internal';
const VALID_ACCESS: ReadonlySet<Access> = new Set<Access>(['public', 'unlisted', 'private', 'internal']);
const DEFAULT_ACCESS: Access = 'unlisted';

export interface DeployOptions {
  name: string;             // human-readable project/app label
  sourceDir: string;        // absolute path to source directory
  target?: DeployTarget;    // force target (auto-detect if omitted)
  port?: number;            // container port (for dynamic apps, default 3000)
  env?: Record<string, string>;  // env vars for container
  description?: string;
  // Phase 1 visibility (Phase 3 — 2026-04-25): default 'unlisted'.
  // unlisted entries get a 6-char random suffix on their slug so
  // the URL is unguessable. Existing entries preserve their slug
  // to keep shared links stable.
  access?: Access;
  slug?: string;            // explicit slug override (rare); usually derived
}

interface ManifestSite {
  name: string;
  slug?: string;            // URL/folder name (with random suffix when unlisted)
  description?: string;
  access: string;
  created_at: string;
  deploy_target?: DeployTarget;
  external_url?: string;
  last_deployed_at?: string;
  thumbnail_url?: string;
  thumbnail_path?: string;
  thumbnail_generated_at?: string;
  thumbnail_status?: ThumbnailStatus;
  thumbnail_error?: string;
  // Optional provenance — which workspace project produced this deploy.
  // Derived from sourceDir on new deploys, backfilled from .publish-log.jsonl
  // on read for legacy entries. Drives the Publishing Hub's grouping UI.
  project?: string;
  // Soft-delete (2026-05-08). When true, the site is hidden from the Hub UI by
  // default and the on-disk path is moved/symlink-removed so URLs return 404.
  // Source files are preserved (in projects/<p>/published/<slug>/ for hybrid
  // mode, or workspace/published/_archived/<slug>__<ts>/ for flat mode) so
  // restore is safe. See workspace/decisions/2026-04-23-publishing-visibility-redesign.md.
  archived?: boolean;
  archived_at?: string;
  archived_path?: string;   // where the folder was moved to (flat mode); undefined for symlink mode
  // Free-form labels (2026-05-08), orthogonal to access tier. Multi-select,
  // user-defined. Lowercased on write so filter/group treats them case-insensitively.
  tags?: string[];
}

interface ManifestApp {
  name: string;
  slug?: string;
  port?: number;
  path?: string;
  description?: string;
  access: string;
  deploy_target?: DeployTarget;
  external_url?: string;
  last_deployed_at?: string;
  project?: string;
  archived?: boolean;
  archived_at?: string;
  tags?: string[];
  [key: string]: unknown;
}

interface Manifest {
  version: number;
  domain: string;
  updated_at: string;
  sites: ManifestSite[];
  apps: ManifestApp[];
  extra_locations?: unknown[];
}

// ── Config ──

function getCloudflareConfig() {
  return {
    apiToken: process.env.CLOUDFLARE_API_TOKEN || '',
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
  };
}

function getAzureConfig() {
  return {
    resourceGroup: process.env.AZURE_RESOURCE_GROUP || 'MAAP-n8n-resources',
    containerEnv: process.env.AZURE_CONTAINER_ENV || 'moat-container-env',
    registry: process.env.AZURE_REGISTRY || 'maapn8nacr.azurecr.io',
    registryName: process.env.AZURE_REGISTRY_NAME || 'maapn8nacr',
  };
}

const PUBLISHED_DIR = () => path.join(config.workspaceRoot, 'published');
const MANIFEST_PATH = () => path.join(PUBLISHED_DIR(), 'manifest.json');
const PUBLISH_LOG_PATH = () => path.join(PUBLISHED_DIR(), '.publish-log.jsonl');
const SITES_DIR = () => path.join(PUBLISHED_DIR(), 'sites');

/**
 * Extract a workspace project name from any path string.
 * Looks for `workspace/projects/<project>/...` and returns `<project>`.
 * Returns undefined for paths outside that convention (e.g., /tmp/...,
 * synthesized AI sites that mkdir directly into published/sites/).
 */
function deriveProjectFromPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const m = p.match(/[\\/]workspace[\\/]projects[\\/]([^\\/]+)/);
  return m ? m[1] : undefined;
}

/**
 * Build a name → project lookup from .publish-log.jsonl.
 * Used to backfill `project` for manifest entries that pre-date the field.
 * Latest log entry wins so a re-deploy from a new project updates the tag.
 *
 * Cached briefly so listing the hub doesn't reparse the log on every request.
 * Cache invalidates on file mtime change so new deploys are picked up.
 */
interface ProjectIndexCache {
  index: Map<string, string>;
  mtimeMs: number;
  builtAt: number;
}
let _projectIndexCache: ProjectIndexCache | null = null;

async function loadProjectIndex(): Promise<Map<string, string>> {
  const logPath = PUBLISH_LOG_PATH();
  let mtimeMs = 0;
  try {
    const st = await fs.stat(logPath);
    mtimeMs = st.mtimeMs;
  } catch {
    return new Map(); // no log file
  }

  if (
    _projectIndexCache &&
    _projectIndexCache.mtimeMs === mtimeMs &&
    Date.now() - _projectIndexCache.builtAt < 60_000
  ) {
    return _projectIndexCache.index;
  }

  const index = new Map<string, string>();
  try {
    const raw = await fs.readFile(logPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (typeof entry.name === 'string') {
          const project = deriveProjectFromPath(entry.src);
          if (project) {
            // Latest entry wins (file is append-only, so iteration order = chronological)
            index.set(entry.name, project);
          }
        }
      } catch { /* skip malformed line */ }
    }
  } catch {
    /* unreadable */
  }

  _projectIndexCache = { index, mtimeMs, builtAt: Date.now() };
  return index;
}

// ── Code Type Detection ──

const SERVER_INDICATORS = [
  // Node.js server patterns
  /require\s*\(\s*['"]express['"]\s*\)/,
  /from\s+['"]express['"]/,
  /require\s*\(\s*['"]fastify['"]\s*\)/,
  /require\s*\(\s*['"]koa['"]\s*\)/,
  /require\s*\(\s*['"]hono['"]\s*\)/,
  /createServer\s*\(/,
  /\.listen\s*\(\s*\d/,
  // Python server patterns
  /from\s+flask\s+import/,
  /from\s+fastapi\s+import/,
  /from\s+django/,
  /uvicorn\.run/,
  /app\.run\s*\(/,
];

const SERVER_FILES = [
  'server.js', 'server.ts', 'server.py',
  'app.js', 'app.ts', 'app.py',
  'main.py', 'index.js', 'index.ts',
  'Dockerfile', 'docker-compose.yml',
  'requirements.txt', 'Pipfile',
];

const STATIC_ONLY_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs',
  '.json', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.pdf', '.mp4', '.webm', '.mp3',
  '.txt', '.xml', '.map',
]);

export async function detectCodeType(sourceDir: string): Promise<'static' | 'dynamic'> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true, recursive: true });

  // Check for server files
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name.toLowerCase();

    // Dockerfile = definitely dynamic
    if (name === 'dockerfile') return 'dynamic';

    // Known server file names → inspect content
    if (SERVER_FILES.includes(name)) {
      const fullPath = path.join((entry as any).parentPath || (entry as any).path || sourceDir, entry.name);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        for (const pattern of SERVER_INDICATORS) {
          if (pattern.test(content)) return 'dynamic';
        }
      } catch { /* skip unreadable files */ }
    }
  }

  // Check if all files are static-only extensions
  const allStatic = entries
    .filter(e => e.isFile())
    .every(e => {
      const ext = path.extname(e.name).toLowerCase();
      return STATIC_ONLY_EXTENSIONS.has(ext) || e.name.startsWith('.');
    });

  if (allStatic) return 'static';

  // Has package.json with start script → probably dynamic
  try {
    const pkgPath = path.join(sourceDir, 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
    if (pkg.scripts?.start) return 'dynamic';
  } catch { /* no package.json */ }

  // Default: static
  return 'static';
}

// ── Cloudflare Pages Deploy ──

async function deployCloudflarPages(opts: DeployOptions): Promise<DeployResult> {
  const cf = getCloudflareConfig();
  if (!cf.apiToken || !cf.accountId) {
    return { success: false, target: 'cloudflare-pages', detectedType: 'static', error: 'Cloudflare credentials not configured. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in .env' };
  }

  const start = Date.now();
  const projectName = opts.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  try {
    // Create project if it doesn't exist (ignore error if already exists)
    try {
      await execFileAsync('npx', [
        'wrangler', 'pages', 'project', 'create', projectName,
        '--production-branch=main',
      ], {
        env: { ...process.env, CLOUDFLARE_API_TOKEN: cf.apiToken, CLOUDFLARE_ACCOUNT_ID: cf.accountId },
        timeout: 30_000,
      });
    } catch (e: any) {
      // "already exists" is fine
      if (!e.stderr?.includes('already exists') && !e.message?.includes('already exists')) {
        // May be a genuine error — but try deploying anyway
        console.warn(`[deploy] CF project create warning: ${e.message}`);
      }
    }

    // Deploy
    const { stdout, stderr } = await execFileAsync('npx', [
      'wrangler', 'pages', 'deploy', opts.sourceDir,
      '--project-name', projectName,
      '--commit-dirty=true',
    ], {
      env: { ...process.env, CLOUDFLARE_API_TOKEN: cf.apiToken, CLOUDFLARE_ACCOUNT_ID: cf.accountId },
      timeout: 120_000,
    });

    // Extract URL from output
    const urlMatch = stdout.match(/https:\/\/[^\s]+\.pages\.dev/) ||
                     stderr.match(/https:\/\/[^\s]+\.pages\.dev/);
    const productionUrl = `https://${projectName}.pages.dev`;

    return {
      success: true,
      target: 'cloudflare-pages',
      url: productionUrl,
      detectedType: 'static',
      duration: Date.now() - start,
    };
  } catch (e: any) {
    return {
      success: false,
      target: 'cloudflare-pages',
      detectedType: 'static',
      error: e.stderr || e.message,
      duration: Date.now() - start,
    };
  }
}

// ── Azure Container Apps Deploy ──

/**
 * Normalize a logical deploy name to Docker/ACA naming rules:
 * lowercase alphanumeric + single hyphens only, must start with a letter,
 * max 32 chars. Consecutive hyphens from "{customer}--{project}" collapse
 * to single hyphens. Same normalization must run in BOTH deploy and delete
 * paths — Azure resources (ACR image, ACA app) always use the normalized
 * form, while manifest.json keeps the logical name (with customer prefix).
 */
export function normalizeAppName(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^([^a-z])/, 'a$1')
    .slice(0, 32);
}

function normalizeSiteSlug(name: string, maxLength = 63): string {
  const cleaned = name.toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^([^a-z0-9])/, 'site-$1');
  const trimmed = cleaned.slice(0, maxLength).replace(/-+$/g, '');
  return trimmed || 'site';
}

/**
 * 6-char hex suffix for unlisted slugs. Mirrors the recipe shipped to AI
 * sessions in templates/workspace/AGENTS.md (`openssl rand -hex 3`) so
 * AI-generated and Gateway-deployed slugs feel uniform. ~24 bits, plenty
 * unguessable for "link-only" semantics.
 */
function randomHexSuffix(): string {
  return crypto.randomBytes(3).toString('hex');
}

function localPublishedUrl(slug: string): string | undefined {
  return publishedSiteUrl(slug, config.publicUrl, config.publishingBaseUrl);
}

function normalizeAccess(requested: string | undefined): Access {
  if (!requested) return DEFAULT_ACCESS;
  const a = String(requested).toLowerCase() as Access;
  return VALID_ACCESS.has(a) ? a : DEFAULT_ACCESS;
}

/**
 * Resolve the slug for a deploy. Stable rules:
 *   - Existing entry → preserve its slug (or fall back to .name) so shared
 *     URLs never break on a re-deploy.
 *   - Brand new + unlisted → base + "-<6 hex>" (collision-checked).
 *   - Brand new + public/private/internal → base (human-readable).
 *   - Caller-provided opts.slug always wins (lets migration tools pin).
 */
function buildDeploySlug(
  baseName: string,
  access: Access,
  existingSlug: string | undefined,
  manifest: Manifest,
  override?: string,
  kind: 'site' | 'app' = 'site',
): string {
  const normalize = kind === 'app' ? normalizeAppName : normalizeSiteSlug;
  if (override) return normalize(override);
  if (existingSlug) return existingSlug;

  const base = kind === 'site'
    ? normalizeSiteSlug(baseName, access === 'unlisted' ? 56 : 63)
    : normalizeAppName(baseName);
  if (access !== 'unlisted') return base;

  // Collision-check across both sites and apps so slug is globally unique
  const taken = new Set<string>([
    ...manifest.sites.map(s => s.slug || s.name),
    ...manifest.apps.map(a => a.slug || a.name),
  ]);
  for (let i = 0; i < 8; i++) {
    const candidate = `${base}-${randomHexSuffix()}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Extremely unlikely fallback
  return `${base}-${Date.now().toString(36).slice(-6)}`;
}

async function resolveDeploySlug(opts: DeployOptions, access: Access): Promise<string> {
  const manifest = await readManifest();
  const existing = manifest.sites.find(s => s.name === opts.name)
    || manifest.apps.find(a => a.name === opts.name);
  return buildDeploySlug(opts.name, access, existing?.slug || existing?.name, manifest, opts.slug);
}

async function copyDirectoryContents(srcDir: string, destDir: string): Promise<void> {
  await copyStaticPublication(srcDir, destDir);
}

async function publishStaticLocally(opts: DeployOptions, slug: string): Promise<void> {
  const destDir = path.join(SITES_DIR(), slug);
  await copyDirectoryContents(opts.sourceDir, destDir);
}

async function deployAzureContainerApps(opts: DeployOptions): Promise<DeployResult> {
  const az = getAzureConfig();
  const start = Date.now();
  const appName = normalizeAppName(opts.name);
  const port = opts.port || 3000;
  const imageName = `${az.registry}/${appName}:latest`;

  try {
    // Step 1: Ensure Dockerfile exists, generate one if needed
    const dockerfilePath = path.join(opts.sourceDir, 'Dockerfile');
    const hasDockerfile = await fs.access(dockerfilePath).then(() => true).catch(() => false);

    if (!hasDockerfile) {
      const dockerfile = await generateDockerfile(opts.sourceDir, port);
      await fs.writeFile(dockerfilePath, dockerfile);
    }

    // Step 2: Build image in ACR
    console.log(`[deploy] Building image ${imageName} in ACR...`);
    await execFileAsync('az', [
      'acr', 'build',
      '--registry', az.registryName,
      '--image', `${appName}:latest`,
      '--file', 'Dockerfile',
      '.',
    ], {
      cwd: opts.sourceDir,
      timeout: 300_000, // 5 min
    });

    // Step 3: Check if container app exists
    let appExists = false;
    try {
      await execFileAsync('az', [
        'containerapp', 'show',
        '--name', appName,
        '--resource-group', az.resourceGroup,
      ], { timeout: 15_000 });
      appExists = true;
    } catch { /* doesn't exist */ }

    // Step 4: Create or update
    if (appExists) {
      console.log(`[deploy] Updating container app ${appName}...`);
      await execFileAsync('az', [
        'containerapp', 'update',
        '--name', appName,
        '--resource-group', az.resourceGroup,
        '--image', imageName,
      ], { timeout: 60_000 });
      // Update env vars separately (update doesn't accept --env-vars inline)
      if (opts.env && Object.keys(opts.env).length > 0) {
        const envPairs = Object.entries(opts.env).map(([k, v]) => `${k}=${v}`);
        await execFileAsync('az', [
          'containerapp', 'update',
          '--name', appName,
          '--resource-group', az.resourceGroup,
          '--set-env-vars', ...envPairs,
        ], { timeout: 60_000 });
      }
    } else {
      console.log(`[deploy] Creating container app ${appName}...`);
      const createArgs = [
        'containerapp', 'create',
        '--name', appName,
        '--resource-group', az.resourceGroup,
        '--environment', az.containerEnv,
        '--image', imageName,
        '--target-port', String(port),
        '--ingress', 'external',
        '--min-replicas', '0',
        '--max-replicas', '3',
        '--registry-server', az.registry,
      ];

      // Add env vars if provided
      if (opts.env && Object.keys(opts.env).length > 0) {
        const envPairs = Object.entries(opts.env).map(([k, v]) => `${k}=${v}`);
        createArgs.push('--env-vars', ...envPairs);
      }

      await execFileAsync('az', createArgs, { timeout: 120_000 });
    }

    // Step 5: Get the FQDN
    const { stdout } = await execFileAsync('az', [
      'containerapp', 'show',
      '--name', appName,
      '--resource-group', az.resourceGroup,
      '--query', 'properties.configuration.ingress.fqdn',
      '-o', 'tsv',
    ], { timeout: 15_000 });

    const fqdn = stdout.trim();
    const url = fqdn ? `https://${fqdn}` : undefined;

    return {
      success: true,
      target: 'azure-container-apps',
      url,
      detectedType: 'dynamic',
      duration: Date.now() - start,
    };
  } catch (e: any) {
    return {
      success: false,
      target: 'azure-container-apps',
      detectedType: 'dynamic',
      error: e.stderr || e.message,
      duration: Date.now() - start,
    };
  }
}

// ── Dockerfile Generator ──

async function generateDockerfile(sourceDir: string, port: number): Promise<string> {
  const hasPkgJson = await fs.access(path.join(sourceDir, 'package.json')).then(() => true).catch(() => false);
  const hasRequirements = await fs.access(path.join(sourceDir, 'requirements.txt')).then(() => true).catch(() => false);
  const hasPipfile = await fs.access(path.join(sourceDir, 'Pipfile')).then(() => true).catch(() => false);

  if (hasRequirements || hasPipfile) {
    // Python app
    const installCmd = hasRequirements ? 'pip install -r requirements.txt' : 'pip install pipenv && pipenv install --system';
    return `FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN ${installCmd}
EXPOSE ${port}
CMD ["python", "app.py"]
`;
  }

  if (hasPkgJson) {
    // Node.js app
    return `FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE ${port}
CMD ["npm", "start"]
`;
  }

  // Generic: just serve with a simple static server as fallback
  return `FROM node:20-slim
WORKDIR /app
RUN npm install -g serve
COPY . .
EXPOSE ${port}
CMD ["serve", "-s", ".", "-l", "${port}"]
`;
}

// ── Manifest Management ──

async function readManifest(): Promise<Manifest> {
  try {
    const raw = await fs.readFile(MANIFEST_PATH(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { version: 2, domain: '', updated_at: new Date().toISOString(), sites: [], apps: [] };
  }
}

async function writeManifest(manifest: Manifest): Promise<void> {
  manifest.updated_at = new Date().toISOString();
  await fs.writeFile(MANIFEST_PATH(), JSON.stringify(manifest, null, 2));
}

async function updateManifestThumbnail(slug: string, thumbnail: ThumbnailResult): Promise<void> {
  const manifest = await readManifest();
  const site = manifest.sites.find((s) => (s.slug || s.name) === slug);
  if (!site) return;
  site.thumbnail_status = thumbnail.status;
  if (thumbnail.thumbnailUrl) site.thumbnail_url = thumbnail.thumbnailUrl;
  if (thumbnail.thumbnailPath) site.thumbnail_path = thumbnail.thumbnailPath;
  if (thumbnail.generatedAt) site.thumbnail_generated_at = thumbnail.generatedAt;
  if (thumbnail.error) site.thumbnail_error = thumbnail.error.slice(0, 500);
  else delete site.thumbnail_error;
  await writeManifest(manifest);
}

export async function updateManifestAfterDeploy(opts: DeployOptions, result: DeployResult): Promise<void> {
  const manifest = await readManifest();
  const now = new Date().toISOString();
  const access = normalizeAccess(opts.access);
  // Workspace project provenance — derived from where the source folder lives.
  // This is the signal the Publishing Hub UI groups by.
  const project = deriveProjectFromPath(opts.sourceDir);

  if (result.detectedType === 'static') {
    const existing = manifest.sites.find(s => s.name === opts.name)
      || (result.slug ? manifest.sites.find(s => s.slug === result.slug || s.name === result.slug) : undefined);
    if (existing) {
      const matchedDiskOnlySlug = result.slug && existing.name === result.slug;
      if (matchedDiskOnlySlug) existing.name = opts.name;
      existing.deploy_target = result.target;
      existing.external_url = result.url;
      existing.last_deployed_at = now;
      if (result.target === 'local' && result.slug) {
        existing.thumbnail_status = 'pending';
        existing.thumbnail_url = thumbnailUrlForSlug(result.slug);
        delete existing.thumbnail_error;
      }
      if (opts.description) existing.description = opts.description;
      // Local publish result.slug is the folder/URL that was actually written.
      // Keep manifest aligned so Hub thumbnails and status checks use the live path.
      if (result.target === 'local' && result.slug) existing.slug = result.slug;
      // Stamp slug for legacy entries that pre-date Phase 1 (preserves URL).
      // Don't re-derive: we never want a re-deploy to break a shared link.
      if (!existing.slug) existing.slug = existing.name;
      // Caller may explicitly change visibility on an existing entry; otherwise
      // keep what was there.
      if (opts.access !== undefined) existing.access = access;
      // Latest deploy wins on project tag (a moved folder retags the entry).
      if (project) existing.project = project;
    } else {
      const slug = buildDeploySlug(opts.name, access, undefined, manifest, opts.slug);
      manifest.sites.push({
        name: opts.name,
        slug,
        description: opts.description || '',
        access,
        created_at: now,
        deploy_target: result.target,
        external_url: result.url,
        last_deployed_at: now,
        ...(result.target === 'local' && slug ? { thumbnail_status: 'pending' as const, thumbnail_url: thumbnailUrlForSlug(slug) } : {}),
        ...(project ? { project } : {}),
      });
    }
  } else {
    const existing = manifest.apps.find(a => a.name === opts.name);
    if (existing) {
      existing.deploy_target = result.target;
      existing.external_url = result.url;
      existing.last_deployed_at = now;
      if (opts.description) existing.description = opts.description;
      if (!existing.slug) existing.slug = existing.name;
      if (opts.access !== undefined) existing.access = access;
      if (project) existing.project = project;
      // Clean up local-only fields when deploying to external platform
      if ((result.target as string) !== 'local') {
        delete existing.port;
        delete existing.path;
        delete existing.health_path;
        delete existing.runtime;
        delete existing.exec;
        delete existing.working_dir;
        delete (existing as any).managed;
      }
    } else {
      const slug = buildDeploySlug(opts.name, access, undefined, manifest, opts.slug, 'app');
      manifest.apps.push({
        name: opts.name,
        slug,
        description: opts.description || '',
        access,
        deploy_target: result.target,
        external_url: result.url,
        last_deployed_at: now,
        ...(project ? { project } : {}),
      });
    }
  }

  await writeManifest(manifest);
}

// ── Main Deploy Function ──

export async function deploy(opts: DeployOptions): Promise<DeployResult> {
  // Validate source directory
  try {
    await fs.access(opts.sourceDir);
  } catch {
    return { success: false, target: 'local', detectedType: 'static', error: `Source directory not found: ${opts.sourceDir}` };
  }

  // Detect code type
  const detectedType = await atDeployStage('detect', () => detectCodeType(opts.sourceDir));

  // Determine target — Phase 3 (i): default static → 'local' (was 'cloudflare-pages').
  // Sites land on disk and nginx serves them via the wildcard subdomain URL.
  // Cloudflare Pages must now be opted in explicitly. Dynamic apps still default
  // to Azure Container Apps —
  // there is no local runtime for them.
  const target = opts.target || (detectedType === 'static' ? 'local' : 'azure-container-apps');

  console.log(`[deploy] ${opts.name}: detected=${detectedType}, target=${target}, source=${opts.sourceDir}`);

  // Deploy
  let result: DeployResult;
  if (target === 'local') {
    // Local publish is a backend-owned bridge: copy the built/static source
    // into workspace/published/sites/<slug>/ so Runtime Box sessions never
    // need direct permissions to create shared symlinks or write published/.
    const start = Date.now();
    const access = normalizeAccess(opts.access);
    const slug = await atDeployStage('prepare', () => resolveDeploySlug(opts, access));
    await atDeployStage('copy', () => publishStaticLocally({ ...opts, slug, access }, slug));
    result = {
      success: true,
      target: 'local',
      slug,
      url: localPublishedUrl(slug),
      detectedType,
      duration: Date.now() - start,
    };
    opts = { ...opts, slug, access };
  } else if (target === 'cloudflare-pages') {
    result = await atDeployStage('provider', () => deployCloudflarPages(opts));
  } else {
    result = await atDeployStage('provider', () => deployAzureContainerApps(opts));
  }

  // Update manifest on success
  if (result.success) {
    await atDeployStage('manifest', () => updateManifestAfterDeploy(opts, result));
    if (result.target === 'local' && result.detectedType === 'static' && result.slug && result.url) {
      generatePublishThumbnailInBackground({ slug: result.slug, url: result.url }, (thumbnail) => updateManifestThumbnail(result.slug!, thumbnail));
    }
  }

  return result;
}

// ── Publish Status (replaces Hub /health) ──

interface SiteStatus extends ManifestSite {
  status: 'live' | 'empty' | 'missing';
  files: number;
}

interface AppStatus extends ManifestApp {
  status: 'up' | 'down' | 'timeout' | 'no-port' | 'external';
  statusCode?: number;
}

async function checkSiteExists(slugOrName: string): Promise<{ status: string; files: number }> {
  const siteDir = path.join(PUBLISHED_DIR(), 'sites', slugOrName);
  try {
    const entries = await fs.readdir(siteDir);
    const files = entries.filter(f => !f.startsWith('.')).length;
    return { status: files > 0 ? 'live' : 'empty', files };
  } catch {
    return { status: 'missing', files: 0 };
  }
}

// ── Title extraction (lazy fallback for empty descriptions) ──
//
// Many sites are created via raw `mkdir + Write index.html` and have no manifest
// entry, so description is an empty string. Reading the first ~8KB of index.html
// and pulling <title> / <meta name="description"> gives the Publishing Hub
// something human-readable next to bare slugs. Cache by file mtime so the 15s
// PublishPanel poll doesn't re-read 100+ files every tick.
//
// Never overwrite a manifest-provided description; this is a fallback only.
// See workspace/decisions/2026-04-29-publishing-local-first.md.

interface CachedTitle { title: string | null; mtime: number; }
const titleCache = new Map<string, CachedTitle>();

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

async function extractSiteTitle(slug: string): Promise<string | null> {
  const indexPath = path.join(PUBLISHED_DIR(), 'sites', slug, 'index.html');
  let mtime: number;
  try {
    const st = await fs.stat(indexPath);
    mtime = st.mtimeMs;
  } catch {
    return null; // no index.html
  }
  const cached = titleCache.get(slug);
  if (cached && cached.mtime === mtime) return cached.title;

  let head = '';
  try {
    const fd = await fs.open(indexPath, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      head = buf.toString('utf8', 0, bytesRead);
    } finally {
      await fd.close();
    }
  } catch {
    titleCache.set(slug, { title: null, mtime });
    return null;
  }

  // Prefer <title>; fall back to <meta name="description">.
  let title: string | null = null;
  const titleMatch = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    const t = decodeBasicEntities(titleMatch[1]).replace(/\s+/g, ' ').trim();
    if (t) title = t;
  }
  if (!title) {
    const metaMatch = head.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)
      || head.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
    if (metaMatch) {
      const t = decodeBasicEntities(metaMatch[1]).replace(/\s+/g, ' ').trim();
      if (t) title = t;
    }
  }
  if (title && title.length > 120) title = title.slice(0, 117) + '...';

  titleCache.set(slug, { title, mtime });
  return title;
}

async function checkAppHealth(app: ManifestApp): Promise<{ status: string; statusCode?: number }> {
  // External deployments — we can't health-check from localhost
  if (app.external_url) {
    return { status: 'external' };
  }
  if (!app.port) {
    return { status: 'no-port' };
  }

  return new Promise((resolve) => {
    const healthPath = (app as any).health_path || '/';
    const req = http.get(
      `http://localhost:${app.port}${healthPath}`,
      { timeout: 3000 },
      (res) => {
        resolve({ status: 'up', statusCode: res.statusCode });
        res.resume(); // drain
      },
    );
    req.on('error', () => resolve({ status: 'down' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 'timeout' }); });
  });
}

/**
 * List all site folders on disk under published/sites/.
 *
 * This is the source of truth for "what's actually being served" — the nginx
 * wildcard config serves any folder present here as a subdomain, regardless
 * of whether it was recorded in manifest.json. Used to merge disk-only sites
 * (created by folder-only workflow, e.g. `mkdir sites/my-page`) into the
 * Publishing Hub listing so the UI doesn't appear empty while sites are live.
 *
 * `linkTarget` is the resolved symlink destination (or undefined for plain
 * directories). Hybrid-storage sites (2026-04-26-publishing-storage-redesign.md)
 * always live as symlinks pointing at workspace/projects/<p>/published/<slug>/,
 * so this is the third signal — beyond manifest + publish-log — that lets us
 * recover the owning project for sites that pre-date the explicit `project`
 * field in the manifest schema.
 */
interface SiteDirEntry {
  name: string;
  createdAt: string;
  linkTarget?: string;
}

async function listSiteDirs(): Promise<SiteDirEntry[]> {
  const sitesDir = path.join(PUBLISHED_DIR(), 'sites');
  try {
    const entries = await fs.readdir(sitesDir, { withFileTypes: true });
    // Use lstat so symlinks themselves count as entries (not their targets).
    // We accept both real directories and symlinks-to-directories as valid sites.
    const candidates = entries.filter(e => !e.name.startsWith('.'));
    const resolved = await Promise.all(candidates.map(async (d): Promise<SiteDirEntry | null> => {
      const full = path.join(sitesDir, d.name);
      let createdAt = new Date().toISOString();
      let linkTarget: string | undefined;
      try {
        const lst = await fs.lstat(full);
        createdAt = lst.mtime.toISOString();
        if (lst.isSymbolicLink()) {
          // realpath resolves relative symlinks to absolute paths, which is what
          // deriveProjectFromPath expects. If the target is missing/broken we
          // fall back to readlink so we still get the intended path string.
          try { linkTarget = await fs.realpath(full); }
          catch { try { linkTarget = await fs.readlink(full); } catch { /* unreadable */ } }
        } else if (!lst.isDirectory()) {
          // Plain files (e.g. robots.txt) — skip
          return null;
        }
      } catch { /* ignore per-entry stat errors */ }
      return { name: d.name, createdAt, linkTarget };
    }));
    return resolved.filter((x): x is SiteDirEntry => x !== null);
  } catch {
    return [];
  }
}

/**
 * Merge manifest sites with on-disk site folders. Manifest is the source
 * of rich metadata (description, deploy_target, external_url); disk is the
 * source of truth for existence. Disk-only entries get a minimal synthetic
 * record so the UI can list them.
 */
async function getMergedSites(): Promise<ManifestSite[]> {
  const manifest = await readManifest();
  const dirs = await listSiteDirs();
  const known = new Set(manifest.sites.flatMap(s => [s.name, s.slug || s.name]));
  const merged: ManifestSite[] = [...manifest.sites];
  // Build a name → linkTarget index up-front so the synth + backfill steps
  // below can both consult it without re-walking dirs.
  const linkTargetByName = new Map<string, string>();
  for (const d of dirs) {
    if (d.linkTarget) linkTargetByName.set(d.name, d.linkTarget);
  }

  for (const d of dirs) {
    if (!known.has(d.name)) {
      // Disk-only sites (created via raw mkdir+Write, no manifest entry) get
      // synthesized as 'unlisted' to match the platform default established in
      // workspace/decisions/2026-04-23-publishing-visibility-redesign.md (the
      // prior 'public' default was a code-policy mismatch — the slug is the
      // user's own creation so we don't know if they wanted it indexed; safer
      // to label them link-only until an admin/operator says otherwise).
      // URL itself is not changed (slug preserved); this affects the UI label
      // and filter group only. If the entry is a symlink into projects/<p>/...
      // we can also recover the owning project for free here.
      merged.push({
        name: d.name,
        description: '',
        access: 'unlisted',
        created_at: d.createdAt,
        project: deriveProjectFromPath(d.linkTarget),
      });
    }
  }
  // Backfill `project` for entries missing it. Three signals, in priority order:
  //   1. publish-log (.publish-log.jsonl) — only catches sites that went through
  //      /api/deploy. Most legacy sites bypass this entirely.
  //   2. disk symlink target — workspace/projects/<p>/published/<slug>/ format
  //      established by 2026-04-26-publishing-storage-redesign.md. This catches
  //      every hybrid-storage site, including pre-Hub legacy entries.
  //   3. (none — leave as undefined → "미분류" group in UI)
  // Rule: only fill when project is missing — never overwrite an explicit
  // manifest value, since the manifest is the user's authoritative choice.
  const projectIndex = await loadProjectIndex();
  for (const s of merged) {
    if (s.project) continue;
    const fromLog = projectIndex.get(s.name);
    if (fromLog) { s.project = fromLog; continue; }
    const fromLink = deriveProjectFromPath(linkTargetByName.get(s.name));
    if (fromLink) s.project = fromLink;
  }

  // Canonicalize local site and thumbnail URLs at read time. Each Tower VM owns
  // its local thumbnail directory, so self-hosted deployment VMs should advertise
  // their own PUBLIC_URL instead of inheriting an absolute operator/dev host
  // from an old manifest. External/gateway deployments keep their provider URL.
  for (const s of merged) {
    if (!s.deploy_target || s.deploy_target === 'local') {
      const slug = s.slug || s.name;
      // Explicit new mode must not silently replace previously published links.
      if (!config.publishingBaseUrl || !s.external_url) s.external_url = localPublishedUrl(slug);
      if (s.thumbnail_url || s.thumbnail_status === 'ready') {
        s.thumbnail_url = thumbnailUrlForSlug(slug);
      }
    }
  }

  // Fallback fill for missing descriptions: peek at index.html's <title> /
  // <meta description> so the Hub UI shows something readable next to bare
  // slugs. Manifest-provided descriptions are preserved untouched. mtime cache
  // keeps repeated polls cheap (only re-reads when the file actually changes).
  const needsTitle = merged.filter(s => !s.description);
  if (needsTitle.length > 0) {
    const titles = await Promise.all(needsTitle.map(s => extractSiteTitle(s.slug || s.name)));
    needsTitle.forEach((s, i) => {
      if (titles[i]) s.description = titles[i]!;
    });
  }

  return merged;
}

/**
 * Apply the same publish-log backfill to apps.
 */
async function backfillAppProjects(apps: ManifestApp[]): Promise<void> {
  const projectIndex = await loadProjectIndex();
  if (projectIndex.size === 0) return;
  for (const a of apps) {
    if (!a.project) {
      const fromLog = projectIndex.get(a.name);
      if (fromLog) a.project = fromLog;
    }
  }
}

export async function getPublishStatus(): Promise<{
  sites: SiteStatus[];
  apps: AppStatus[];
  projects: Record<string, string>;
}> {
  const manifest = await readManifest();
  const mergedSites = await getMergedSites();

  const sites: SiteStatus[] = await Promise.all(
    mergedSites.map(async (s) => {
      const check = await checkSiteExists(s.slug || s.name);
      return { ...s, status: check.status as SiteStatus['status'], files: check.files };
    }),
  );

  await backfillAppProjects(manifest.apps);
  const apps: AppStatus[] = await Promise.all(
    manifest.apps.map(async (a) => {
      const check = await checkAppHealth(a);
      return { ...a, status: check.status as AppStatus['status'], statusCode: check.statusCode };
    }),
  );

  // folder → display name map for the Hub UI. Failures swallow to {} so
  // status response always renders (frontend falls back to folder name).
  const { loadProjectDisplayMap } = await import('../publishing/project-display.js');
  const projects = await loadProjectDisplayMap();

  return { sites, apps, projects };
}

// ── Traffic Stats (replaces Hub /stats) ──

interface TrafficEntry {
  hits: number;
  path: string;
}

export async function getTrafficStats(): Promise<TrafficEntry[]> {
  try {
    const { stdout } = await execFileAsync('tail', ['-1000', '/var/log/nginx/access.log'], { timeout: 5000 });
    const pathCounts: Record<string, number> = {};
    for (const line of stdout.split('\n')) {
      // nginx combined log: ... "GET /path HTTP/1.1" ...
      const match = line.match(/"(?:GET|POST|PUT|DELETE|PATCH)\s+([^\s"]+)/);
      if (match) {
        const p = match[1].split('?')[0]; // strip query string
        // Only count published sites/apps paths
        if (p.startsWith('/sites/') || p.startsWith('/apps/')) {
          pathCounts[p] = (pathCounts[p] || 0) + 1;
        }
      }
    }
    return Object.entries(pathCounts)
      .map(([p, hits]) => ({ path: p, hits }))
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 50);
  } catch {
    return [];
  }
}

// ── List Deployments ──

export async function listDeployments(): Promise<{ sites: ManifestSite[]; apps: ManifestApp[] }> {
  const manifest = await readManifest();
  const sites = await getMergedSites();
  await backfillAppProjects(manifest.apps);
  return {
    sites,
    apps: manifest.apps,
  };
}

// ── Delete Deployment ──

export async function deleteDeployment(name: string, type: 'site' | 'app'): Promise<{ success: boolean; error?: string }> {
  const manifest = await readManifest();

  if (type === 'site') {
    const site = manifest.sites.find(s => s.name === name);
    if (!site) return { success: false, error: 'Site not found' };

    // Delete from Cloudflare if it was deployed there
    if (site.deploy_target === 'cloudflare-pages') {
      const cf = getCloudflareConfig();
      try {
        await execFileAsync('npx', [
          'wrangler', 'pages', 'project', 'delete', name, '--yes',
        ], {
          env: { ...process.env, CLOUDFLARE_API_TOKEN: cf.apiToken, CLOUDFLARE_ACCOUNT_ID: cf.accountId },
          timeout: 30_000,
        });
      } catch (e: any) {
        console.warn(`[deploy] CF delete warning: ${e.message}`);
      }
    }

    manifest.sites = manifest.sites.filter(s => s.name !== name);
  } else {
    const app = manifest.apps.find(a => a.name === name);
    if (!app) return { success: false, error: 'App not found' };

    // Delete from Azure if it was deployed there.
    // Azure resources always use the normalized name — manifest may still
    // hold the logical "{customer}--{project}" form.
    if (app.deploy_target === 'azure-container-apps') {
      const az = getAzureConfig();
      const azName = normalizeAppName(name);
      try {
        await execFileAsync('az', [
          'containerapp', 'delete',
          '--name', azName,
          '--resource-group', az.resourceGroup,
          '--yes',
        ], { timeout: 60_000 });
      } catch (e: any) {
        console.warn(`[deploy] Azure ACA delete warning: ${e.message}`);
      }
      // Also purge the ACR image so we don't leak storage
      try {
        await execFileAsync('az', [
          'acr', 'repository', 'delete',
          '--name', az.registryName,
          '--repository', azName,
          '--yes',
        ], { timeout: 30_000 });
      } catch (e: any) {
        console.warn(`[deploy] ACR image delete warning: ${e.message}`);
      }
    }

    manifest.apps = manifest.apps.filter(a => a.name !== name);
  }

  await writeManifest(manifest);
  return { success: true };
}

// ── Visibility (access tier) updates ──
//
// Pure manifest mutation — never touches slug, site folder, or external deploy.
// Used by PATCH /api/publish/sites/:slug/access and the bulk endpoint.
// Disk-only sites (no manifest entry) get promoted to a manifest record on
// first change so the choice persists across polls.
// Slug is preserved unconditionally (URL stability — see
// workspace/decisions/2026-04-23-publishing-visibility-redesign.md).

export async function updateSiteAccess(
  slugOrName: string,
  access: Access,
): Promise<{ ok: boolean; created: boolean; site?: ManifestSite; error?: string }> {
  if (!VALID_ACCESS.has(access)) {
    return { ok: false, created: false, error: `Invalid access '${access}'` };
  }
  const manifest = await readManifest();
  const idx = manifest.sites.findIndex(s => s.name === slugOrName || s.slug === slugOrName);
  if (idx >= 0) {
    manifest.sites[idx].access = access;
    await writeManifest(manifest);
    return { ok: true, created: false, site: manifest.sites[idx] };
  }
  // Not in manifest — promote disk-only site (slug = name).
  const dirs = await listSiteDirs();
  const found = dirs.find(d => d.name === slugOrName);
  if (!found) {
    return { ok: false, created: false, error: `Site '${slugOrName}' not found on disk or in manifest` };
  }
  const entry: ManifestSite = {
    name: slugOrName,
    slug: slugOrName,
    description: '',
    access,
    created_at: found.createdAt,
  };
  manifest.sites.push(entry);
  await writeManifest(manifest);
  return { ok: true, created: true, site: entry };
}

export async function updateSitesAccessBulk(
  slugsOrNames: string[],
  access: Access,
): Promise<{ ok: boolean; changed: number; created: number; missing: string[]; error?: string }> {
  if (!VALID_ACCESS.has(access)) {
    return { ok: false, changed: 0, created: 0, missing: [], error: `Invalid access '${access}'` };
  }
  if (!Array.isArray(slugsOrNames) || slugsOrNames.length === 0) {
    return { ok: false, changed: 0, created: 0, missing: [], error: 'slugs (non-empty array) required' };
  }
  const manifest = await readManifest();
  const dirs = await listSiteDirs();
  const dirMap = new Map(dirs.map(d => [d.name, d.createdAt]));
  let changed = 0;
  let created = 0;
  const missing: string[] = [];
  for (const name of slugsOrNames) {
    const idx = manifest.sites.findIndex(s => s.name === name || s.slug === name);
    if (idx >= 0) {
      manifest.sites[idx].access = access;
      changed++;
    } else if (dirMap.has(name)) {
      manifest.sites.push({
        name,
        slug: name,
        description: '',
        access,
        created_at: dirMap.get(name)!,
      });
      created++;
    } else {
      missing.push(name);
    }
  }
  await writeManifest(manifest);
  return { ok: true, changed, created, missing };
}

// ── Archive / Unarchive (soft-delete) ──
//
// "Archive" = take a published site offline without losing its files.
// Two storage shapes coexist (workspace/decisions/2026-04-26-publishing-storage-redesign.md):
//   • hybrid  — workspace/projects/<p>/published/<slug>/ is the truth,
//               workspace/published/sites/<slug> is a symlink. Archive removes
//               the symlink only; unarchive recreates it.
//   • flat    — workspace/published/sites/<slug>/ is the truth (no project
//               context). Archive moves the folder to workspace/published/
//               _archived/<slug>__<ISOts>/; unarchive moves it back.
// Either way the URL stops resolving (nginx serves only what's in published/sites/).
// Manifest entry is kept and marked `archived: true` so the Hub can list and restore.

const ARCHIVE_DIR = () => path.join(PUBLISHED_DIR(), '_archived');

async function isSymlink(p: string): Promise<boolean> {
  try {
    const st = await fs.lstat(p);
    return st.isSymbolicLink();
  } catch { return false; }
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.lstat(p); return true; } catch { return false; }
}

export async function archiveSite(
  slugOrName: string,
): Promise<{ ok: boolean; mode?: 'symlink' | 'flat' | 'noop'; error?: string }> {
  const manifest = await readManifest();
  const idx = manifest.sites.findIndex(s => s.name === slugOrName || s.slug === slugOrName);

  // Promote disk-only sites to manifest first (mirrors updateSiteAccess pattern)
  let siteIdx = idx;
  if (siteIdx < 0) {
    const dirs = await listSiteDirs();
    const found = dirs.find(d => d.name === slugOrName);
    if (!found) {
      return { ok: false, error: `Site '${slugOrName}' not found on disk or in manifest` };
    }
    manifest.sites.push({
      name: slugOrName,
      slug: slugOrName,
      description: '',
      access: 'unlisted',
      created_at: found.createdAt,
    });
    siteIdx = manifest.sites.length - 1;
  }
  const site = manifest.sites[siteIdx];
  const slug = site.slug || site.name;
  const livePath = path.join(PUBLISHED_DIR(), 'sites', slug);

  if (site.archived) {
    // Already archived — make it idempotent.
    return { ok: true, mode: 'noop' };
  }

  let mode: 'symlink' | 'flat' | 'noop' = 'noop';
  if (await pathExists(livePath)) {
    if (await isSymlink(livePath)) {
      // Hybrid mode: drop the symlink, real files stay in projects/<p>/published/<slug>/
      await fs.unlink(livePath);
      mode = 'symlink';
    } else {
      // Flat mode: move the folder out of the served directory.
      await fs.mkdir(ARCHIVE_DIR(), { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const destPath = path.join(ARCHIVE_DIR(), `${slug}__${ts}`);
      await fs.rename(livePath, destPath);
      site.archived_path = destPath;
      mode = 'flat';
    }
  }
  site.archived = true;
  site.archived_at = new Date().toISOString();
  await writeManifest(manifest);
  return { ok: true, mode };
}

export async function unarchiveSite(
  slugOrName: string,
): Promise<{ ok: boolean; error?: string }> {
  const manifest = await readManifest();
  const siteIdx = manifest.sites.findIndex(s => s.name === slugOrName || s.slug === slugOrName);
  if (siteIdx < 0) return { ok: false, error: `Site '${slugOrName}' not in manifest` };
  const site = manifest.sites[siteIdx];
  if (!site.archived) return { ok: true };

  const slug = site.slug || site.name;
  const livePath = path.join(PUBLISHED_DIR(), 'sites', slug);

  if (site.archived_path) {
    // Flat mode: move folder back. If livePath got recreated meanwhile, refuse
    // to clobber and surface an error so the operator can resolve manually.
    if (await pathExists(livePath)) {
      return { ok: false, error: `Cannot restore: ${livePath} already exists` };
    }
    if (await pathExists(site.archived_path)) {
      await fs.rename(site.archived_path, livePath);
    }
    delete site.archived_path;
  } else if (site.project) {
    // Hybrid mode: recreate symlink to projects/<p>/published/<slug>/
    const target = path.join(config.workspaceRoot, 'projects', site.project, 'published', slug);
    if (await pathExists(target) && !(await pathExists(livePath))) {
      // Use relative target so the symlink stays portable across moves.
      const relTarget = path.relative(path.dirname(livePath), target);
      await fs.symlink(relTarget, livePath);
    }
  }
  // If neither: site has no on-disk source we can recover. Mark un-archived
  // anyway so the manifest state matches user intent — the row will simply
  // show as missing in the Hub.
  site.archived = false;
  delete site.archived_at;
  await writeManifest(manifest);
  return { ok: true };
}

export async function archiveSitesBulk(
  slugsOrNames: string[],
): Promise<{ ok: boolean; archived: number; missing: string[] }> {
  if (!Array.isArray(slugsOrNames) || slugsOrNames.length === 0) {
    return { ok: false, archived: 0, missing: [] };
  }
  let archived = 0;
  const missing: string[] = [];
  for (const name of slugsOrNames) {
    const r = await archiveSite(name);
    if (r.ok) archived++;
    else missing.push(name);
  }
  return { ok: true, archived, missing };
}

// ── Tags (free-form labels, orthogonal to access tier) ──
//
// Multi-select, user-defined, lowercased on write. Persisted in manifest so
// they survive across restarts and propagate via the same /publish/status
// endpoint that already drives the Hub UI.

const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().toLowerCase();
    if (!TAG_RE.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.slice(0, 16); // cap at 16 tags per site
}

export async function setSiteTags(
  slugOrName: string,
  tags: string[],
): Promise<{ ok: boolean; site?: ManifestSite; error?: string }> {
  const cleaned = normalizeTags(tags);
  const manifest = await readManifest();
  let idx = manifest.sites.findIndex(s => s.name === slugOrName || s.slug === slugOrName);
  if (idx < 0) {
    // Promote disk-only site so the tag persists.
    const dirs = await listSiteDirs();
    const found = dirs.find(d => d.name === slugOrName);
    if (!found) return { ok: false, error: `Site '${slugOrName}' not found` };
    manifest.sites.push({
      name: slugOrName,
      slug: slugOrName,
      description: '',
      access: 'unlisted',
      created_at: found.createdAt,
    });
    idx = manifest.sites.length - 1;
  }
  manifest.sites[idx].tags = cleaned.length > 0 ? cleaned : undefined;
  await writeManifest(manifest);
  return { ok: true, site: manifest.sites[idx] };
}

export async function modifySitesTagsBulk(
  slugsOrNames: string[],
  action: 'add' | 'remove' | 'set',
  tags: string[],
): Promise<{ ok: boolean; changed: number; missing: string[]; error?: string }> {
  if (!Array.isArray(slugsOrNames) || slugsOrNames.length === 0) {
    return { ok: false, changed: 0, missing: [], error: 'slugs (non-empty array) required' };
  }
  const cleaned = normalizeTags(tags);
  if (action !== 'set' && cleaned.length === 0) {
    return { ok: false, changed: 0, missing: [], error: 'No valid tags provided' };
  }
  const manifest = await readManifest();
  let changed = 0;
  const missing: string[] = [];
  for (const name of slugsOrNames) {
    const idx = manifest.sites.findIndex(s => s.name === name || s.slug === name);
    if (idx < 0) { missing.push(name); continue; }
    const current = new Set((manifest.sites[idx].tags || []).map(t => t.toLowerCase()));
    let next: Set<string>;
    if (action === 'set') next = new Set(cleaned);
    else if (action === 'add') { next = new Set(current); for (const t of cleaned) next.add(t); }
    else { next = new Set(current); for (const t of cleaned) next.delete(t); } // remove
    const nextArr = Array.from(next).slice(0, 16);
    manifest.sites[idx].tags = nextArr.length > 0 ? nextArr : undefined;
    changed++;
  }
  await writeManifest(manifest);
  return { ok: true, changed, missing };
}

/**
 * Aggregate every distinct tag currently in use, with usage count.
 * Used by the Hub UI's tag-picker autocomplete so users can re-use existing
 * labels instead of inventing near-duplicates ("client-acme" vs "acme-client").
 */
export async function listAllSiteTags(): Promise<Array<{ tag: string; count: number }>> {
  const manifest = await readManifest();
  const counts = new Map<string, number>();
  for (const s of manifest.sites) {
    for (const t of s.tags || []) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
