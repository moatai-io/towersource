/**
 * pkg-info.ts — single source of truth for version metadata.
 *
 * A normal source checkout prefers fresh Git metadata so stale PM2 environment
 * variables cannot survive a restart. A packaged runtime such as a Nix closure
 * has no .git directory, so it must inject the complete TOWER_* release
 * contract instead of falling back to the intentionally stale package.json
 * version.
 *
 * Decision: workspace/decisions/2026-07-16-nix-renderer-authority-and-tower-app-shadow-phase5.md
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type ReleaseMetadataSource = 'git' | 'injected' | 'package';

export interface ReleaseMetadata {
  version: string;
  baseVersion: string;
  commitsSinceTag: number | null;
  gitSha: string | null;
  buildTime: string;
  sourceRev: string | null;
  flakeLockNarHash: string | null;
  metadataSource: ReleaseMetadataSource;
}

interface ReleaseMetadataDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => Date;
  exec?: (command: string) => string;
  packageInfo?: { version: string; name: string };
}

function resolveRootPkg(cwd = process.cwd()): { version: string; name: string } {
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', '..', 'package.json'),
    path.resolve(__dirname, '..', '..', '..', 'package.json'),
    path.resolve(cwd, 'package.json'),
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (pkg?.name === 'tower' && pkg?.version) return { version: pkg.version, name: pkg.name };
    } catch {
      // keep trying
    }
  }
  return { version: '0.0.0-unknown', name: 'tower' };
}

function defaultExec(command: string): string {
  return execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

function safeExec(exec: (command: string) => string, command: string): string | null {
  try {
    return exec(command).trim() || null;
  } catch {
    return null;
  }
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function synthesizeVersion(baseVersion: string, commitsSinceTag: number | null): string {
  return commitsSinceTag && commitsSinceTag > 0
    ? `${baseVersion}+${commitsSinceTag}`
    : baseVersion;
}

/**
 * Resolve release metadata once at boot.
 *
 * Precedence is deliberate:
 *  1. A no-Git packaged runtime marked by TOWER_PACKAGED_RELEASE=true requires
 *     TOWER_VERSION + TOWER_BASE_VERSION + GIT_SHA + SOURCE_REV and must not
 *     inherit release identity from an external runtime cwd's Git checkout.
 *  2. A normal source checkout resolves live Git identity before PM2 env.
 *  3. Complete injected metadata remains the no-Git image compatibility path.
 *  4. package.json is a compatibility fallback only.
 */
export function resolveReleaseMetadata(deps: ReleaseMetadataDeps = {}): ReleaseMetadata {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? (() => new Date());
  const exec = deps.exec ?? defaultExec;
  const packageInfo = deps.packageInfo ?? resolveRootPkg(cwd);

  const injected = {
    version: env.TOWER_VERSION?.trim(),
    baseVersion: env.TOWER_BASE_VERSION?.trim(),
    gitSha: env.GIT_SHA?.trim(),
    sourceRev: env.SOURCE_REV?.trim(),
  };
  const hasAnyInjected = Object.values(injected).some(Boolean);
  const hasCompleteInjected = Object.values(injected).every(Boolean);
  const packagedRelease = env.TOWER_PACKAGED_RELEASE === 'true';

  if (packagedRelease && !hasCompleteInjected) {
    const missing = Object.entries(injected).filter(([, value]) => !value).map(([key]) => key);
    throw new Error(`Incomplete packaged release metadata: missing ${missing.join(', ')}`);
  }

  const gitSha = packagedRelease ? null : safeExec(exec, 'git rev-parse HEAD');
  const gitTag = packagedRelease ? null : safeExec(exec, "git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname")
    ?.split('\n')[0]?.trim() || null;

  if (gitSha) {
    const baseVersion = gitTag?.replace(/^v/, '') || packageInfo.version;
    const rawCount = gitTag ? safeExec(exec, `git rev-list ${gitTag}..HEAD --count`) : null;
    const commitsSinceTag = parseNonNegativeInteger(rawCount ?? undefined);
    return {
      version: synthesizeVersion(baseVersion, commitsSinceTag),
      baseVersion,
      commitsSinceTag,
      gitSha: gitSha.slice(0, 12),
      buildTime: env.BUILD_TIME || now().toISOString(),
      sourceRev: gitSha,
      flakeLockNarHash: env.FLAKE_LOCK_NAR_HASH?.trim() || null,
      metadataSource: 'git',
    };
  }

  if (hasAnyInjected && !hasCompleteInjected) {
    const missing = Object.entries(injected).filter(([, value]) => !value).map(([key]) => key);
    throw new Error(`Incomplete packaged release metadata: missing ${missing.join(', ')}`);
  }

  if (hasCompleteInjected) {
    return {
      version: injected.version!,
      baseVersion: injected.baseVersion!,
      commitsSinceTag: parseNonNegativeInteger(env.TOWER_COMMITS_SINCE_TAG),
      gitSha: injected.gitSha!.slice(0, 12),
      buildTime: env.BUILD_TIME || now().toISOString(),
      sourceRev: injected.sourceRev!,
      flakeLockNarHash: env.FLAKE_LOCK_NAR_HASH?.trim() || null,
      metadataSource: 'injected',
    };
  }

  return {
    version: packageInfo.version,
    baseVersion: packageInfo.version,
    commitsSinceTag: null,
    gitSha: env.GIT_SHA?.slice(0, 12) || null,
    buildTime: env.BUILD_TIME || now().toISOString(),
    sourceRev: env.SOURCE_REV?.trim() || null,
    flakeLockNarHash: env.FLAKE_LOCK_NAR_HASH?.trim() || null,
    metadataSource: 'package',
  };
}

const metadata = resolveReleaseMetadata();

export const VERSION = metadata.version;
export const BASE_VERSION = metadata.baseVersion;
export const COMMITS_SINCE_TAG = metadata.commitsSinceTag;
export const GIT_SHA = metadata.gitSha;
export const BUILD_TIME = metadata.buildTime;
export const SOURCE_REV = metadata.sourceRev;
export const FLAKE_LOCK_NAR_HASH = metadata.flakeLockNarHash;
export const RELEASE_METADATA_SOURCE = metadata.metadataSource;

/** Stable additive payload used by /api/health and /api/config. */
export function getVersionInfo(): ReleaseMetadata {
  return { ...metadata };
}
