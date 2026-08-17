/**
 * Owns: Project-scoped managed skill materialization under `.tower/skills`.
 * Public API: materializeProjectRegistrySkills. See skill-bundle-resolver.ts and skill-materialization-scanner.ts.
 * Boundary: never prune or overwrite project-owned local skill gardens (`SKILL_GARDEN.md`, `skills/`, `skill-lab/`).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { computeBundleDigest, resolveRegistrySkillBundle } from './skill-bundle-resolver.js';
import type { RegistrySkillBundle } from './skill-bundle-resolver.js';
import {
  scanSkillBundleForMaterialization,
  scanSkillBundleForReadOnlyMount,
} from './skill-materialization-scanner.js';
import type { SkillBundleScanFinding } from './skill-materialization-scanner.js';

export interface MaterializeProjectRegistrySkillsOptions {
  projectRootPath: string;
  skillNames: string[];
  /** ISO timestamp override for deterministic tests. */
  now?: Date;
  /** Allow hidden registry skills. Admin/operator diagnostics only. */
  includeHidden?: boolean;
  /** If true, remove managed skill folders not in skillNames. Default true. */
  prune?: boolean;
  /** MVP runtime storage. Default copy; bind-ro permits large bundles and keeps a host control copy. */
  storageMode?: 'copy' | 'bind-ro';
}

export interface MaterializedProjectSkillManifestEntry {
  name: string;
  version: string;
  source: 'registry';
  sourceKind: RegistrySkillBundle['sourceKind'];
  catalog: RegistrySkillBundle['catalog'];
  ownership: RegistrySkillBundle['ownership'];
  visibility: RegistrySkillBundle['visibility'];
  managed: true;
  materializedAt: string;
  requiredSecrets: string[];
  canonicalId: string;
  bundleDigest: string;
  sourceCommit?: string;
  sourceProject?: string;
  sourcePath?: string;
  origin?: string;
  runtimePath: string;
  storageMode?: 'copy' | 'bind-ro';
  fallbackMode?: 'copy' | 'control-only';
  files: Array<{
    relativePath: string;
    sizeBytes: number;
    sha256: string;
  }>;
}

export interface ProjectSkillMaterializationManifest {
  schemaVersion: 2 | 3;
  generatedAt: string;
  managedBy: 'tower-project-skill-materializer' | 'tower-project-skill-runtime-layer';
  skills: MaterializedProjectSkillManifestEntry[];
}

export interface ProjectSkillMaterializationResult {
  ok: boolean;
  projectRootPath: string;
  targetRootPath: string;
  manifestPath: string;
  materialized: MaterializedProjectSkillManifestEntry[];
  skipped: Array<{
    name: string;
    reason: 'not_found_or_disallowed' | 'scan_failed';
    findings?: SkillBundleScanFinding[];
  }>;
  findings: Array<{
    name: string;
    findings: SkillBundleScanFinding[];
  }>;
  pruned: string[];
}

const MANIFEST_FILE = 'manifest.json';
const MANAGED_MARKER_FILE = '.tower-managed-skill';

/**
 * Materialize allowed registry skills into a project-local system-managed folder:
 *
 * Host path:
 *   `<projectRootPath>/.tower/skills/<skill>/...`
 *
 * Runtime Box path:
 *   `/workspace/.tower/skills/<skill>/...`
 */
export function materializeProjectRegistrySkills(
  opts: MaterializeProjectRegistrySkillsOptions,
): ProjectSkillMaterializationResult {
  const projectRootPath = path.resolve(opts.projectRootPath);
  const targetRootPath = path.join(projectRootPath, '.tower', 'skills');
  const manifestPath = path.join(targetRootPath, MANIFEST_FILE);
  const generatedAt = (opts.now ?? new Date()).toISOString();
  const requestedSkillNames = uniqueSkillNames(opts.skillNames);
  const storageMode = opts.storageMode ?? 'copy';
  const materialized: MaterializedProjectSkillManifestEntry[] = [];
  const skipped: ProjectSkillMaterializationResult['skipped'] = [];
  const findings: ProjectSkillMaterializationResult['findings'] = [];

  fs.mkdirSync(targetRootPath, { recursive: true });

  for (const skillName of requestedSkillNames) {
    const bundle = resolveRegistrySkillBundle(skillName, { includeHidden: opts.includeHidden });
    if (!bundle) {
      skipped.push({ name: skillName, reason: 'not_found_or_disallowed' });
      continue;
    }

    const copyScan = scanSkillBundleForMaterialization(bundle.rootPath);
    const runtimeScan = storageMode === 'bind-ro'
      ? scanSkillBundleForReadOnlyMount(bundle.rootPath)
      : copyScan;
    if (runtimeScan.findings.length > 0) findings.push({ name: skillName, findings: runtimeScan.findings });
    if (!runtimeScan.ok) {
      skipped.push({ name: skillName, reason: 'scan_failed', findings: runtimeScan.findings });
      continue;
    }

    const skillTargetRoot = safeSkillTargetRoot(targetRootPath, skillName);
    const fallbackMode: 'copy' | 'control-only' = storageMode === 'bind-ro' ? 'control-only' : 'copy';
    const hostFiles = fallbackMode === 'control-only'
      ? runtimeScan.filesAllowed.filter(isControlFile)
      : copyScan.filesAllowed;
    replaceSkillDirectory(bundle.rootPath, skillTargetRoot, hostFiles, fallbackMode === 'control-only');
    fs.writeFileSync(path.join(skillTargetRoot, MANAGED_MARKER_FILE), buildMarker(bundle, generatedAt), 'utf-8');

    const runtimeFiles = runtimeScan.filesAllowed.map((relativePath) => fileEntry(bundle.rootPath, relativePath));
    materialized.push({
      name: bundle.name,
      version: bundle.version,
      source: 'registry',
      sourceKind: bundle.sourceKind,
      catalog: bundle.catalog,
      ownership: bundle.ownership,
      visibility: bundle.visibility,
      managed: true,
      materializedAt: generatedAt,
      requiredSecrets: bundle.requiredSecrets,
      canonicalId: bundle.canonicalId,
      bundleDigest: storageMode === 'bind-ro' ? computeBundleDigest(runtimeFiles) : bundle.bundleDigest,
      ...(bundle.sourceCommit ? { sourceCommit: bundle.sourceCommit } : {}),
      ...(bundle.sourceProject ? { sourceProject: bundle.sourceProject } : {}),
      ...(bundle.sourcePath ? { sourcePath: bundle.sourcePath } : {}),
      ...(bundle.origin ? { origin: bundle.origin } : {}),
      runtimePath: `/workspace/.tower/skills/${bundle.name}`,
      ...(storageMode === 'bind-ro' ? { storageMode, fallbackMode } : {}),
      files: runtimeFiles,
    });
  }

  const pruned = opts.prune === false ? [] : pruneUnrequestedManagedSkills(targetRootPath, new Set(materialized.map((s) => s.name)));
  const manifest: ProjectSkillMaterializationManifest = {
    schemaVersion: storageMode === 'bind-ro' ? 3 : 2,
    generatedAt,
    managedBy: storageMode === 'bind-ro'
      ? 'tower-project-skill-runtime-layer'
      : 'tower-project-skill-materializer',
    skills: materialized.sort((a, b) => a.name.localeCompare(b.name)),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  return {
    ok: skipped.length === 0,
    projectRootPath,
    targetRootPath,
    manifestPath,
    materialized: manifest.skills,
    skipped,
    findings,
    pruned,
  };
}

function uniqueSkillNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function safeSkillTargetRoot(targetRootPath: string, skillName: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(skillName)) {
    throw new Error(`Invalid skill name for materialization: ${skillName}`);
  }
  const target = path.resolve(targetRootPath, skillName);
  const root = path.resolve(targetRootPath);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Materialization target escapes .tower/skills: ${skillName}`);
  }
  return target;
}

function replaceSkillDirectory(
  sourceRoot: string,
  targetRoot: string,
  filesAllowed: string[],
  preserveTargetRoot = false,
): void {
  let keepExistingRoot = false;
  if (preserveTargetRoot) {
    try {
      const stat = fs.lstatSync(targetRoot);
      keepExistingRoot = stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
      keepExistingRoot = false;
    }
  }

  if (keepExistingRoot) {
    for (const entry of fs.readdirSync(targetRoot)) {
      fs.rmSync(path.join(targetRoot, entry), { recursive: true, force: true });
    }
  } else {
    fs.rmSync(targetRoot, { recursive: true, force: true });
    fs.mkdirSync(targetRoot, { recursive: true });
  }

  for (const relativePath of filesAllowed) {
    const source = path.resolve(sourceRoot, relativePath);
    const target = path.resolve(targetRoot, relativePath);
    const relToSourceRoot = path.relative(path.resolve(sourceRoot), source);
    const relToTargetRoot = path.relative(path.resolve(targetRoot), target);
    if (relToSourceRoot.startsWith('..') || path.isAbsolute(relToSourceRoot)) {
      throw new Error(`Source path escapes skill root: ${relativePath}`);
    }
    if (relToTargetRoot.startsWith('..') || path.isAbsolute(relToTargetRoot)) {
      throw new Error(`Target path escapes materialized skill root: ${relativePath}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

function isControlFile(relativePath: string): boolean {
  return relativePath === 'SKILL.md' || relativePath === 'skill.yaml';
}

function fileEntry(skillTargetRoot: string, relativePath: string): MaterializedProjectSkillManifestEntry['files'][number] {
  const abs = path.join(skillTargetRoot, relativePath);
  const content = fs.readFileSync(abs);
  const stat = fs.statSync(abs);
  return {
    relativePath,
    sizeBytes: stat.size,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

function buildMarker(bundle: RegistrySkillBundle, generatedAt: string): string {
  return [
    'managed-by=tower-project-skill-materializer',
    `name=${bundle.name}`,
    `version=${bundle.version}`,
    `catalog=${bundle.catalog}`,
    `canonical-id=${bundle.canonicalId}`,
    `bundle-digest=${bundle.bundleDigest}`,
    ...(bundle.sourceCommit ? [`source-commit=${bundle.sourceCommit}`] : []),
    ...(bundle.sourceProject ? [`source-project=${bundle.sourceProject}`] : []),
    ...(bundle.sourcePath ? [`source-path=${bundle.sourcePath}`] : []),
    ...(bundle.origin ? [`origin=${bundle.origin}`] : []),
    `materialized-at=${generatedAt}`,
    '',
  ].join('\n');
}

function pruneUnrequestedManagedSkills(targetRootPath: string, keep: Set<string>): string[] {
  const pruned: string[] = [];
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(targetRootPath, { withFileTypes: true });
  } catch {
    return pruned;
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    if (keep.has(dirent.name)) continue;
    const candidate = path.join(targetRootPath, dirent.name);
    if (!fs.existsSync(path.join(candidate, MANAGED_MARKER_FILE))) continue;
    fs.rmSync(candidate, { recursive: true, force: true });
    pruned.push(dirent.name);
  }
  return pruned.sort();
}
