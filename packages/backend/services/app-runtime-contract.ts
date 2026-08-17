/**
 * Phase 5 Tower app packaging contract.
 *
 * This module is data-only on purpose: the future Nix derivation and artifact
 * probe can consume the same allowlist without starting the backend.
 * Decisions:
 * - workspace/decisions/2026-07-16-nix-renderer-authority-and-tower-app-shadow-phase5.md
 * - workspace/decisions/2026-07-17-nix-tower-app-production-phase6.md
 */

export type RuntimePathClass = 'immutable' | 'external-writable' | 'external-readonly' | 'secret-env';

export interface RuntimePathContractEntry {
  id: string;
  classification: RuntimePathClass;
  source: string;
  packagedPath?: string;
  runtimeEnv?: string;
  required: boolean;
  rationale: string;
}

export const APP_RUNTIME_PATH_CONTRACT: readonly RuntimePathContractEntry[] = [
  {
    id: 'frontend-dist',
    classification: 'immutable',
    source: 'dist/frontend',
    packagedPath: 'lib/tower/dist/frontend',
    required: true,
    rationale: 'Production frontend static assets.',
  },
  {
    id: 'backend-dist',
    classification: 'immutable',
    source: 'dist/backend',
    packagedPath: 'lib/tower/dist/backend',
    required: true,
    rationale: 'Compiled backend entrypoint and modules.',
  },
  {
    id: 'root-package-metadata',
    classification: 'immutable',
    source: 'package.json',
    packagedPath: 'lib/tower/package.json',
    required: true,
    rationale: 'Compatibility metadata; injected release metadata remains authoritative in packaged runtimes.',
  },
  {
    id: 'backend-model-registry',
    classification: 'immutable',
    source: 'packages/backend/models.json',
    packagedPath: 'lib/tower/packages/backend/models.json',
    required: true,
    rationale: 'Runtime model registry loaded by backend config.',
  },
  {
    id: 'database-migrations',
    classification: 'immutable',
    source: 'packages/backend/db/migrations',
    packagedPath: 'lib/tower/packages/backend/db/migrations',
    required: true,
    rationale: 'Migration payload required for isolated DB packaging smoke and future authority.',
  },
  {
    id: 'runtime-guides',
    classification: 'immutable',
    source: 'docs/tower-guide/resources',
    packagedPath: 'lib/tower/docs/tower-guide/resources',
    required: true,
    rationale: 'Guide-backed Pi tools resolve these resources at runtime.',
  },
  {
    id: 'root-runtime-dependencies',
    classification: 'immutable',
    source: 'node_modules',
    packagedPath: 'lib/tower/node_modules',
    required: true,
    rationale: 'Root npm runtime dependency graph owned by the closure.',
  },
  {
    id: 'backend-workspace-dependencies',
    classification: 'immutable',
    source: 'packages/backend/node_modules',
    packagedPath: 'lib/tower/packages/backend/node_modules',
    required: true,
    rationale: 'Workspace-nested SDK dependencies must resolve without a source checkout symlink.',
  },
  {
    id: 'runtime-state',
    classification: 'external-writable',
    source: 'data',
    runtimeEnv: 'TOWER_DATA_DIR',
    required: true,
    rationale: 'Blobs, interrupted-session records, backups and generated state cannot live in the read-only store.',
  },
  {
    id: 'workspace',
    classification: 'external-writable',
    source: 'workspace',
    runtimeEnv: 'WORKSPACE_ROOT',
    required: true,
    rationale: 'Projects, uploads and published outputs remain external persistent data.',
  },
  {
    id: 'default-cwd',
    classification: 'external-readonly',
    source: 'workspace',
    runtimeEnv: 'DEFAULT_CWD',
    required: true,
    rationale: 'Session cwd is configured outside the package; shadow profiles use synthetic roots.',
  },
  {
    id: 'tower-source',
    classification: 'external-readonly',
    source: 'tower-source',
    runtimeEnv: 'TOWER_REPO_ROOT',
    required: false,
    rationale: 'Git/source operations are optional and must not infer a writable checkout from the Nix store.',
  },
  {
    id: 'service-secrets',
    classification: 'secret-env',
    source: '.env',
    required: true,
    rationale: 'Secrets and customer config are injected by the service environment and never packaged.',
  },
] as const;

/** Paths that must never enter a Tower app Nix source or output closure. */
export const APP_PACKAGE_FORBIDDEN_INPUTS = [
  '.env',
  '.git',
  '.pi',
  'data',
  'dist',
  'node_modules',
  'workspace',
  'uploads',
  'published',
] as const;

/** Complete no-Git release identity required by a packaged app runtime. */
export const PACKAGED_RELEASE_REQUIRED_ENV = [
  'TOWER_VERSION',
  'TOWER_BASE_VERSION',
  'GIT_SHA',
  'SOURCE_REV',
] as const;

export const PACKAGED_RELEASE_OPTIONAL_ENV = [
  'TOWER_COMMITS_SINCE_TAG',
  'BUILD_TIME',
  'FLAKE_LOCK_NAR_HASH',
] as const;
