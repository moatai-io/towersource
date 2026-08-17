/**
 * Owns: Building the Docker bind-ro mount plan for schema v3 managed project skills.
 * Public API: buildRuntimeSkillBindMountPlan, projectUsesSkillBindMount.
 * See README.md and workspace/decisions/2026-07-10-project-skill-read-only-bind-mount.md.
 *
 * The project keeps only its manifest and minimal control files for host discovery.
 * Runtime Box overlays each manifest-listed skill with the canonical teamskills source.
 */
import fs from 'fs';
import path from 'path';
import { resolveRegistrySkillBundle } from './skill-bundle-resolver.js';
import { scanSkillBundleForReadOnlyMount } from './skill-materialization-scanner.js';

interface ProjectSkillManifestLike {
  schemaVersion?: unknown;
  managedBy?: unknown;
  skills?: Array<{ name?: unknown; storageMode?: unknown }>;
}

export interface RuntimeSkillBindMount {
  name: string;
  sourcePath: string;
  targetPath: string;
}

export interface RuntimeSkillBindMountPlan {
  enabled: boolean;
  mounts: RuntimeSkillBindMount[];
  skipped: Array<{ name: string; reason: string }>;
  durationMs: number;
}

/**
 * Enable bind-ro only for a complete schema v3 desired state. Schema v2 remains
 * the explicit copy-mode contract and is never upgraded implicitly at box start.
 */
export function projectUsesSkillBindMount(
  project: { id?: string; name?: string; rootPath: string },
): boolean {
  const manifestPath = path.join(path.resolve(project.rootPath), '.tower', 'skills', 'manifest.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ProjectSkillManifestLike;
    if (
      manifest.schemaVersion === 3
      && manifest.managedBy === 'tower-project-skill-runtime-layer'
      && Array.isArray(manifest.skills)
      && manifest.skills.length > 0
      && manifest.skills.every((entry) => entry.storageMode === 'bind-ro')
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Resolve manifest-listed teamskills into Docker child mounts under /workspace.
 * Missing, unsafe, symlinked, or mismatched sources are skipped instead of mounted.
 */
export function buildRuntimeSkillBindMountPlan(projectRootPath: string): RuntimeSkillBindMountPlan {
  const started = performance.now();
  const projectRoot = path.resolve(projectRootPath);
  const manifestPath = path.join(projectRoot, '.tower', 'skills', 'manifest.json');
  const mounts: RuntimeSkillBindMount[] = [];
  const skipped: RuntimeSkillBindMountPlan['skipped'] = [];

  let manifest: ProjectSkillManifestLike;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ProjectSkillManifestLike;
  } catch (err) {
    return {
      enabled: false,
      mounts,
      skipped: [{ name: '*', reason: `manifest_unavailable:${(err as Error).message}` }],
      durationMs: performance.now() - started,
    };
  }

  if (
    manifest.schemaVersion !== 3
    || manifest.managedBy !== 'tower-project-skill-runtime-layer'
    || !Array.isArray(manifest.skills)
    || manifest.skills.some((entry) => entry.storageMode !== 'bind-ro')
  ) {
    return {
      enabled: false,
      mounts,
      skipped: [{ name: '*', reason: 'manifest_not_bind_ro_v3' }],
      durationMs: performance.now() - started,
    };
  }

  const names = [...new Set(manifest.skills
    .map((entry) => typeof entry?.name === 'string' ? entry.name.trim() : '')
    .filter(Boolean))];

  for (const name of names) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      skipped.push({ name, reason: 'invalid_name' });
      continue;
    }
    const bundle = resolveRegistrySkillBundle(name);
    if (!bundle) {
      skipped.push({ name, reason: 'source_missing' });
      continue;
    }
    const scan = scanSkillBundleForReadOnlyMount(bundle.rootPath);
    if (!scan.ok) {
      skipped.push({ name, reason: 'source_scan_failed' });
      continue;
    }

    let sourcePath: string;
    try {
      sourcePath = fs.realpathSync(bundle.rootPath);
      const declaredRoot = path.resolve(bundle.rootPath);
      if (sourcePath !== declaredRoot) {
        skipped.push({ name, reason: 'source_symlink_not_allowed' });
        continue;
      }
    } catch {
      skipped.push({ name, reason: 'source_realpath_failed' });
      continue;
    }

    if (sourcePath.includes(',')) {
      skipped.push({ name, reason: 'source_path_not_mount_safe' });
      continue;
    }

    const targetHostPath = path.resolve(projectRoot, '.tower', 'skills', name);
    const targetRelative = path.relative(projectRoot, targetHostPath);
    if (targetRelative.startsWith('..') || path.isAbsolute(targetRelative)) {
      skipped.push({ name, reason: 'target_escape' });
      continue;
    }
    try {
      const targetStat = fs.lstatSync(targetHostPath);
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
        skipped.push({ name, reason: 'materialized_target_not_directory' });
        continue;
      }
    } catch {
      skipped.push({ name, reason: 'materialized_target_missing' });
      continue;
    }

    mounts.push({
      name,
      sourcePath,
      targetPath: `/workspace/.tower/skills/${name}`,
    });
  }

  return {
    enabled: mounts.length > 0 && skipped.length === 0,
    mounts: mounts.sort((a, b) => a.name.localeCompare(b.name)),
    skipped,
    durationMs: performance.now() - started,
  };
}

/** Convert a validated plan to Docker CLI arguments without invoking a shell. */
export function runtimeSkillDockerMountArgs(plan: RuntimeSkillBindMountPlan): string[] {
  if (!plan.enabled) return [];
  return plan.mounts.flatMap((mount) => [
    '--mount',
    `type=bind,src=${mount.sourcePath},dst=${mount.targetPath},readonly,bind-propagation=rprivate`,
  ]);
}
