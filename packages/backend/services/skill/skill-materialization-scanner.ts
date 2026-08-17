/**
 * Owns: Safety and transport scanning for registry skill bundles.
 * Public API: scanSkillBundleForMaterialization, scanSkillBundleForReadOnlyMount. See skill-bundle-resolver.ts.
 */
import fs from 'fs';
import path from 'path';

export type SkillBundleScanSeverity = 'error' | 'warning';

export interface SkillBundleScanFinding {
  severity: SkillBundleScanSeverity;
  code: string;
  relativePath: string;
  message: string;
}

export interface SkillBundleScanResult {
  ok: boolean;
  rootPath: string;
  filesAllowed: string[];
  findings: SkillBundleScanFinding[];
}

export interface SkillBundleScanOptions {
  maxFileSizeBytes?: number;
  maxTotalSizeBytes?: number;
  allowSecretLikeFiles?: string[];
  /** Generated/cache paths are skipped from copy digests; mount mode may warn or reject. */
  generatedArtifactPolicy?: 'skip' | 'warn' | 'error';
}

const DEFAULT_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_SIZE_BYTES = 20 * 1024 * 1024;
const UNLIMITED_TRANSPORT_SIZE = Number.POSITIVE_INFINITY;

const DENIED_EXACT_NAMES = new Set([
  '.env',
  '.git',
  '.hg',
  '.svn',
]);

const IGNORED_GENERATED_EXACT_NAMES = new Set([
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'dist',
  'build',
  '.next',
  '.nuxt',
]);

const DENIED_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.crt',
  '.cer',
]);

const SECRET_LIKE_RE = /(^|[-_.])(secret|token|credential|credentials|password|passwd|apikey|api_key|private[-_]?key)([-_.]|$)/i;

/**
 * Scan a skill bundle root before copying it into a project.
 *
 * This scanner is deliberately conservative. It blocks files that are likely
 * secrets, dependency caches, build outputs, traversal attempts, and symlinks
 * escaping the skill root. Findings with severity `error` must prevent
 * materialization.
 */
export function scanSkillBundleForMaterialization(
  rootPath: string,
  opts: SkillBundleScanOptions = {},
): SkillBundleScanResult {
  return scanSkillBundle(rootPath, opts);
}

/**
 * Scan a bundle before exposing its full directory through a read-only bind mount.
 * Size limits are copy transport concerns, so mount scanning has no 2MB/20MB cap.
 * Generated/cache directories are warnings: read-only mount prevents mutation, but
 * operators should clean them from teamskills source because they remain visible.
 */
export function scanSkillBundleForReadOnlyMount(
  rootPath: string,
  opts: Pick<SkillBundleScanOptions, 'allowSecretLikeFiles'> = {},
): SkillBundleScanResult {
  return scanSkillBundle(rootPath, {
    ...opts,
    maxFileSizeBytes: UNLIMITED_TRANSPORT_SIZE,
    maxTotalSizeBytes: UNLIMITED_TRANSPORT_SIZE,
    generatedArtifactPolicy: 'warn',
  });
}

function scanSkillBundle(
  rootPath: string,
  opts: SkillBundleScanOptions,
): SkillBundleScanResult {
  const resolvedRoot = path.resolve(rootPath);
  const findings: SkillBundleScanFinding[] = [];
  const filesAllowed: string[] = [];
  const allowSecretLikeFiles = new Set((opts.allowSecretLikeFiles ?? []).map(normalizeRelativePath));
  const maxFileSizeBytes = opts.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const maxTotalSizeBytes = opts.maxTotalSizeBytes ?? DEFAULT_MAX_TOTAL_SIZE_BYTES;
  const generatedArtifactPolicy = opts.generatedArtifactPolicy ?? 'skip';
  let totalSize = 0;

  if (!fs.existsSync(resolvedRoot)) {
    return {
      ok: false,
      rootPath: resolvedRoot,
      filesAllowed: [],
      findings: [{
        severity: 'error',
        code: 'root_missing',
        relativePath: '.',
        message: `Skill bundle root does not exist: ${resolvedRoot}`,
      }],
    };
  }

  walk(resolvedRoot, '');

  if (totalSize > maxTotalSizeBytes) {
    findings.push({
      severity: 'error',
      code: 'bundle_too_large',
      relativePath: '.',
      message: `Bundle total size ${totalSize} exceeds ${maxTotalSizeBytes} bytes`,
    });
  }

  return {
    ok: findings.every((finding) => finding.severity !== 'error'),
    rootPath: resolvedRoot,
    filesAllowed: filesAllowed.sort(),
    findings,
  };

  function walk(absDir: string, relDir: string): void {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      findings.push({
        severity: 'error',
        code: 'read_failed',
        relativePath: relDir || '.',
        message: `Could not read directory: ${String(err)}`,
      });
      return;
    }

    for (const dirent of dirents) {
      const rel = normalizeRelativePath(relDir ? path.posix.join(relDir, dirent.name) : dirent.name);
      const abs = path.join(absDir, dirent.name);

      const pathFinding = validateRelativePath(rel);
      if (pathFinding) {
        findings.push(pathFinding);
        continue;
      }

      const ignoredGeneratedFinding = validateIgnoredGeneratedName(rel, dirent.name, generatedArtifactPolicy);
      if (ignoredGeneratedFinding) {
        findings.push(ignoredGeneratedFinding);
        continue;
      }

      const nameFinding = validateName(rel, dirent.name, allowSecretLikeFiles);
      if (nameFinding) {
        findings.push(nameFinding);
        if (nameFinding.severity === 'error') continue;
      }

      if (dirent.isSymbolicLink()) {
        const linkFinding = validateSymlink(resolvedRoot, abs, rel);
        findings.push(linkFinding);
        continue;
      }

      if (dirent.isDirectory()) {
        walk(abs, rel);
        continue;
      }

      if (!dirent.isFile()) {
        findings.push({
          severity: 'warning',
          code: 'non_regular_file_skipped',
          relativePath: rel,
          message: 'Skipping non-regular file',
        });
        continue;
      }

      const stat = fs.statSync(abs);
      totalSize += stat.size;
      if (stat.size > maxFileSizeBytes) {
        findings.push({
          severity: 'error',
          code: 'file_too_large',
          relativePath: rel,
          message: `File size ${stat.size} exceeds ${maxFileSizeBytes} bytes`,
        });
        continue;
      }

      filesAllowed.push(rel);
    }
  }
}

function normalizeRelativePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\//, '');
}

function validateRelativePath(relativePath: string): SkillBundleScanFinding | null {
  if (relativePath.startsWith('/') || relativePath.includes('../') || relativePath === '..') {
    return {
      severity: 'error',
      code: 'path_traversal',
      relativePath,
      message: 'Path escapes or attempts to escape the skill root',
    };
  }
  return null;
}

function validateIgnoredGeneratedName(
  relativePath: string,
  basename: string,
  policy: 'skip' | 'warn' | 'error',
): SkillBundleScanFinding | null {
  if (IGNORED_GENERATED_EXACT_NAMES.has(basename) || basename.endsWith('.pyc')) {
    return {
      severity: policy === 'error' ? 'error' : 'warning',
      code: 'generated_artifact_skipped',
      relativePath,
      message: `Skipping generated materialization artifact: ${basename}`,
    };
  }
  return null;
}

function validateName(
  relativePath: string,
  basename: string,
  allowSecretLikeFiles: Set<string>,
): SkillBundleScanFinding | null {
  if (DENIED_EXACT_NAMES.has(basename) || basename.startsWith('.env.')) {
    return {
      severity: 'error',
      code: 'denied_name',
      relativePath,
      message: `Denied materialization path name: ${basename}`,
    };
  }

  const ext = path.extname(basename).toLowerCase();
  if (DENIED_EXTENSIONS.has(ext)) {
    return {
      severity: 'error',
      code: 'denied_extension',
      relativePath,
      message: `Denied materialization file extension: ${ext}`,
    };
  }

  if (!allowSecretLikeFiles.has(relativePath) && SECRET_LIKE_RE.test(basename)) {
    return {
      severity: 'error',
      code: 'secret_like_name',
      relativePath,
      message: 'Filename looks like it may contain secrets or credentials',
    };
  }

  return null;
}

function validateSymlink(rootPath: string, absPath: string, relativePath: string): SkillBundleScanFinding {
  try {
    const realRoot = fs.realpathSync(rootPath);
    const realTarget = fs.realpathSync(absPath);
    const relToRoot = path.relative(realRoot, realTarget);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
      return {
        severity: 'error',
        code: 'symlink_escape',
        relativePath,
        message: 'Symlink target escapes the skill root',
      };
    }
    return {
      severity: 'warning',
      code: 'symlink_skipped',
      relativePath,
      message: 'Symlink is inside the skill root but is skipped for deterministic materialization',
    };
  } catch (err) {
    return {
      severity: 'error',
      code: 'symlink_unreadable',
      relativePath,
      message: `Could not resolve symlink: ${String(err)}`,
    };
  }
}
