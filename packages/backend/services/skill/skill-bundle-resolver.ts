/**
 * Owns: Resolving registry skills into internal bundle metadata for project-scoped materialization.
 * Public API: resolveRegistrySkillBundle, resolveRegistrySkillBundles. See skill-materialization-scanner.ts.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getTeamskillsProjectRoot, getTeamskillsSkillRoot, isSafeSkillName } from './teamskills-source.js';
import { scanSkillBundleForMaterialization } from './skill-materialization-scanner.js';
import type { SkillAccessGrant, SkillPortability, SkillRuntimeRequirements, SkillVisibility } from '@tower/shared';

export type SkillBundleSourceKind = 'teamskills';

export interface SkillBundleFileEntry {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}

export interface RegistrySkillBundle {
  name: string;
  version: string;
  sourceKind: SkillBundleSourceKind;
  catalog: 'teamskills';
  visibility: SkillVisibility;
  ownership: 'org';
  rootPath: string;
  skillPath: string;
  requiredSecrets: string[];
  canonicalId: string;
  bundleDigest: string;
  sourceCommit?: string;
  sourceProject?: string;
  sourcePath?: string;
  origin?: string;
  runtimeRequirements?: SkillRuntimeRequirements;
  portability?: SkillPortability;
  access?: SkillAccessGrant[];
  files: SkillBundleFileEntry[];
}

export interface ResolveRegistrySkillBundleOptions {
  /** Reserved for compatibility with older callers. Teamskills sources are not hidden by this resolver. */
  includeHidden?: boolean;
}

/**
 * Resolve a library/registry skill into internal bundle metadata.
 *
 * The returned paths are backend-internal only. They must not be copied into
 * member/customer prompts; project sessions should see materialized paths under
 * `/workspace/.tower/skills/<skill>/` instead.
 */
export function resolveRegistrySkillBundle(
  skillName: string,
  opts: ResolveRegistrySkillBundleOptions = {},
): RegistrySkillBundle | null {
  void opts;
  return resolveTeamskillsBundle(skillName);
}

function resolveTeamskillsBundle(skillName: string): RegistrySkillBundle | null {
  if (!isSafeSkillName(skillName)) return null;
  const rootPath = path.resolve(getTeamskillsSkillRoot(skillName));
  const skillPath = path.join(rootPath, 'SKILL.md');
  if (!fs.existsSync(skillPath)) return null;
  const skillYamlPath = path.join(rootPath, 'skill.yaml');
  const skillMd = safeReadText(skillPath);
  const skillYaml = safeReadText(skillYamlPath);
  const version = parseSimpleMetadataField(skillYaml, 'version') || parseSimpleMetadataField(skillMd, 'version') || '';
  const requiredSecrets = parseSimpleMetadataArray(skillYaml, 'requiredSecrets');
  const sourceProject = parseSimpleMetadataField(skillYaml, 'sourceProject') || 'teamskills';
  const sourcePath = parseSimpleMetadataField(skillYaml, 'sourcePath') || path.posix.join('skills', skillName);
  const origin = parseSimpleMetadataField(skillYaml, 'origin') || 'org';
  const files = listBundleFiles(rootPath);
  const sourceCommit = resolveGitSourceCommit(rootPath);
  return {
    name: skillName,
    version,
    sourceKind: 'teamskills',
    catalog: 'teamskills',
    visibility: 'default',
    ownership: 'org',
    rootPath,
    skillPath,
    requiredSecrets,
    canonicalId: `tower://org/teamskills/${skillName}`,
    bundleDigest: computeBundleDigest(files),
    ...(sourceCommit ? { sourceCommit } : {}),
    sourceProject,
    sourcePath: normalizeTeamskillsSourcePath(rootPath, sourcePath),
    origin,
    files,
  };
}

/** Resolve many registry skill bundles, preserving input order and skipping missing/disallowed names. */
export function resolveRegistrySkillBundles(
  skillNames: string[],
  opts: ResolveRegistrySkillBundleOptions = {},
): RegistrySkillBundle[] {
  const seen = new Set<string>();
  const bundles: RegistrySkillBundle[] = [];
  for (const name of skillNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    const bundle = resolveRegistrySkillBundle(name, opts);
    if (bundle) bundles.push(bundle);
  }
  return bundles;
}

function normalizeTeamskillsSourcePath(rootPath: string, fallback: string): string {
  const teamskillsRoot = path.resolve(getTeamskillsProjectRoot());
  const relative = path.relative(teamskillsRoot, rootPath).split(path.sep).join(path.posix.sep);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  return fallback;
}

function safeReadText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function parseSimpleMetadataField(content: string, field: string): string {
  if (!content) return '';
  const match = content.match(new RegExp(`^${field}:\\s*['\"]?([^'\"\\n]+)['\"]?\\s*$`, 'm'));
  return match?.[1]?.trim() ?? '';
}

function parseSimpleMetadataArray(content: string, field: string): string[] {
  if (!content) return [];
  const inline = content.match(new RegExp(`^${field}:\\s*\\[([^\\]]*)\\]\\s*$`, 'm'));
  if (inline) {
    return inline[1]
      .split(',')
      .map((item) => item.trim().replace(/^['\"]|['\"]$/g, ''))
      .filter(Boolean);
  }
  const block = content.match(new RegExp(`^${field}:\\s*\\n((?:\\s*-\\s*[^\\n]+\\n?)+)`, 'm'));
  if (!block) return [];
  return block[1]
    .split('\n')
    .map((line) => line.trim().replace(/^-\s*/, '').replace(/^['\"]|['\"]$/g, ''))
    .filter(Boolean);
}

function listBundleFiles(rootPath: string): SkillBundleFileEntry[] {
  const scan = scanSkillBundleForMaterialization(rootPath);
  return scan.filesAllowed.map((relativePath) => fileEntry(rootPath, relativePath));
}

function fileEntry(rootPath: string, relativePath: string): SkillBundleFileEntry {
  const abs = path.join(rootPath, relativePath);
  const content = fs.readFileSync(abs);
  const stat = fs.statSync(abs);
  return {
    relativePath,
    sizeBytes: stat.size,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

/** Compute one normalized digest from the scanner-allowed file inventory. */
export function computeBundleDigest(files: SkillBundleFileEntry[]): string {
  const hash = crypto.createHash('sha256');
  // Use deterministic Unicode code-point order so Runtime Box's stdlib-only
  // doctor can reproduce the digest without host locale/Intl differences.
  for (const file of [...files].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)) {
    hash.update(`${file.relativePath}\0${file.sizeBytes}\0${file.sha256}\n`, 'utf-8');
  }
  return `sha256:${hash.digest('hex')}`;
}

function resolveGitSourceCommit(startPath: string): string | null {
  let current = path.resolve(startPath);
  while (true) {
    const gitPath = path.join(current, '.git');
    if (fs.existsSync(gitPath)) return readGitHeadCommit(gitPath, current);
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readGitHeadCommit(gitPath: string, worktreeRoot: string): string | null {
  try {
    let gitDir = gitPath;
    if (fs.statSync(gitPath).isFile()) {
      const match = fs.readFileSync(gitPath, 'utf-8').match(/^gitdir:\s*(.+)$/m);
      if (!match) return null;
      gitDir = path.resolve(worktreeRoot, match[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
    if (/^[a-f0-9]{40}$/i.test(head)) return head.toLowerCase();
    const refMatch = head.match(/^ref:\s*(.+)$/);
    if (!refMatch) return null;
    const ref = refMatch[1].trim();
    const looseRef = path.join(gitDir, ...ref.split('/'));
    if (fs.existsSync(looseRef)) {
      const commit = fs.readFileSync(looseRef, 'utf-8').trim();
      return /^[a-f0-9]{40}$/i.test(commit) ? commit.toLowerCase() : null;
    }
    const packedRefs = path.join(gitDir, 'packed-refs');
    if (!fs.existsSync(packedRefs)) return null;
    for (const line of fs.readFileSync(packedRefs, 'utf-8').split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      const [commit, packedRef] = line.trim().split(/\s+/, 2);
      if (packedRef === ref && /^[a-f0-9]{40}$/i.test(commit)) return commit.toLowerCase();
    }
  } catch {}
  return null;
}
