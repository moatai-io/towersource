/**
 * Owns: Standalone process entrypoint for the credential-free Remote Workbench Worker.
 * Public API: loadRemoteWorkbenchWorkerConfig, startRemoteWorkbenchWorker.
 *
 * Configuration is file-backed except for the bearer token. Project roots are operator-owned
 * allowlist entries; requests can never supply host paths. This process does not load Tower DB,
 * Vault, engines, schedules, or Service machinery.
 */

import { buildWorkerCanonicalWriteAuthority, type WorkerCanonicalWriteConfig } from './worker-canonical-write-config.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { WorkerMaintenanceGate } from '../../runtime-box/worker-maintenance-gate.js';
import { createRemoteWorkbenchWorkerServer } from './worker-server.js';

const workerConfigSchema = z.object({
  canonicalFileWrites: z.object({ backendUrl: z.string().url(), verificationKeyFile: z.string().min(1), replayRoot: z.string().min(1) }).strict().optional(),
  workerId: z.string().min(1).max(120),
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535),
  projects: z.record(z.string().min(1), z.string().min(1)),
  projectsRoot: z.string().min(1).optional(),
  projections: z.record(z.string().regex(/^\/workspace\/[A-Za-z0-9._/-]+$/), z.string().min(1)).optional(),
  managedSkillsRoot: z.string().min(1).optional(),
  bwrapBin: z.string().min(1).optional(),
  isolationProfile: z.enum(['legacy-skill-dependent', 'project-sandbox-v1']).optional(),
  runtimeProvenance: z.object({
    sourceRev: z.string().min(1).optional(),
    storePath: z.string().min(1).optional(),
  }).strict().optional(),
  operatorGitIdentity: z.object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(320),
  }).strict().optional(),
}).strict();

export interface RemoteWorkbenchWorkerConfig {
  canonicalFileWrites?: WorkerCanonicalWriteConfig;
  workerId: string;
  host: string;
  port: number;
  projects: Record<string, string>;
  projectsRoot?: string;
  projections?: Record<string, string>;
  managedSkillsRoot?: string;
  bwrapBin?: string;
  isolationProfile?: 'legacy-skill-dependent' | 'project-sandbox-v1';
  runtimeProvenance?: { sourceRev?: string; storePath?: string };
  operatorGitIdentity?: { name: string; email: string };
}

/** Load and validate an operator-owned Worker allowlist without reading secret values from disk. */
export function loadRemoteWorkbenchWorkerConfig(configPath: string): RemoteWorkbenchWorkerConfig {
  const resolvedConfig = path.resolve(configPath);
  const parsed = workerConfigSchema.parse(JSON.parse(fs.readFileSync(resolvedConfig, 'utf8')));
  const projects = Object.fromEntries(Object.entries(parsed.projects).map(([projectId, projectRoot]) => {
    const resolvedRoot = path.resolve(projectRoot);
    const stat = fs.statSync(resolvedRoot);
    if (!stat.isDirectory()) throw new Error(`Remote Worker project root is not a directory: ${projectId}`);
    return [projectId, resolvedRoot];
  }));
  if (Object.keys(projects).length === 0) throw new Error('Remote Worker requires at least one allowlisted project');
  const projections = parsed.projections && Object.fromEntries(Object.entries(parsed.projections).map(([target, source]) => {
    const resolvedSource = path.resolve(source);
    const stat = fs.statSync(resolvedSource);
    if (!stat.isDirectory()) throw new Error(`Remote Worker projection source is not a directory: ${target}`);
    return [target, resolvedSource];
  }));
  const projectsRoot = parsed.projectsRoot ? path.resolve(parsed.projectsRoot) : undefined;
  const managedSkillsRoot = parsed.managedSkillsRoot ? path.resolve(parsed.managedSkillsRoot) : undefined;
  if (managedSkillsRoot && !fs.statSync(managedSkillsRoot).isDirectory()) throw new Error('Remote Worker managed skills root is not a directory');
  const bwrapBin = parsed.bwrapBin ? path.resolve(parsed.bwrapBin) : process.env.TOWER_WORKER_BWRAP_BIN?.trim();
  if (!bwrapBin || !path.isAbsolute(bwrapBin) || !fs.statSync(bwrapBin).isFile()) throw new Error('Remote Worker bubblewrap binary is required');
  return { ...parsed, projects, ...(projectsRoot ? { projectsRoot } : {}), ...(projections ? { projections } : {}), ...(managedSkillsRoot ? { managedSkillsRoot } : {}), bwrapBin };
}

/** Start one standalone Worker process from fixed config and an environment-injected bearer token. */
export function startRemoteWorkbenchWorker(env: NodeJS.ProcessEnv = process.env) {
  const configPath = env.TOWER_REMOTE_WORKER_CONFIG;
  const token = env.TOWER_REMOTE_WORKER_TOKEN;
  if (!configPath) throw new Error('TOWER_REMOTE_WORKER_CONFIG is required');
  if (!token) throw new Error('TOWER_REMOTE_WORKER_TOKEN is required');
  const config = loadRemoteWorkbenchWorkerConfig(configPath);
  // Provenance is derived from this loaded immutable module, never mutable config.
  const modulePath = fileURLToPath(import.meta.url);
  const match = /^(\/nix\/store\/[^/]+)\/lib\/tower\//.exec(modulePath);
  const storePath = match?.[1];
  const manifest = storePath ? JSON.parse(fs.readFileSync(path.join(storePath, 'share/tower/release-manifest.json'), 'utf8')) : null;
  const canonicalFileWrites = buildWorkerCanonicalWriteAuthority(config.canonicalFileWrites,
    [...Object.values(config.projects), ...(config.projectsRoot ? [config.projectsRoot] : []), ...Object.values(config.projections ?? {})],
    env.TOWER_WORKER_IDENTITY_TOKEN);
  const server = createRemoteWorkbenchWorkerServer({
    canonicalFileWrites,
    maintenanceGate: new WorkerMaintenanceGate(env.TOWER_WORKER_MAINTENANCE_STATE),
    maintenanceSmokeRoot: env.TOWER_WORKER_MAINTENANCE_SMOKE_ROOT,
    maintenanceStateFile: env.TOWER_WORKER_MAINTENANCE_STATE,
    workerId: config.workerId,
    token,
    projects: config.projects,
    projectsRoot: config.projectsRoot,
    projections: config.projections,
    managedSkillsRoot: config.managedSkillsRoot,
    bwrapBin: config.bwrapBin,
    isolationProfile: config.isolationProfile,
    runtimeProvenance: { storePath, sourceRev: manifest?.sourceRev },
    operatorGitIdentity: config.operatorGitIdentity,
  });
  server.listen(config.port, config.host, () => {
    console.log(`[remote-workbench-worker] worker=${config.workerId} listen=${config.host}:${config.port} projects=${Object.keys(config.projects).length}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startRemoteWorkbenchWorker();
}
