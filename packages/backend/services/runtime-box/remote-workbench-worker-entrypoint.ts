/**
 * Owns: Standalone process entrypoint for the credential-free Remote Workbench Worker.
 * Public API: loadRemoteWorkbenchWorkerConfig, startRemoteWorkbenchWorker.
 *
 * Configuration is file-backed except for the bearer token. Project roots are operator-owned
 * allowlist entries; requests can never supply host paths. This process does not load Tower DB,
 * Vault, engines, schedules, or Service machinery.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createRemoteWorkbenchWorkerServer } from './remote-workbench-worker-server.js';

const workerConfigSchema = z.object({
  workerId: z.string().min(1).max(120),
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535),
  projects: z.record(z.string().min(1), z.string().min(1)),
  projections: z.record(z.string().regex(/^\/workspace\/[A-Za-z0-9._/-]+$/), z.string().min(1)).optional(),
  operatorGitIdentity: z.object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(320),
  }).strict().optional(),
}).strict();

export interface RemoteWorkbenchWorkerConfig {
  workerId: string;
  host: string;
  port: number;
  projects: Record<string, string>;
  projections?: Record<string, string>;
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
  return { ...parsed, projects, ...(projections ? { projections } : {}) };
}

/** Start one standalone Worker process from fixed config and an environment-injected bearer token. */
export function startRemoteWorkbenchWorker(env: NodeJS.ProcessEnv = process.env) {
  const configPath = env.TOWER_REMOTE_WORKER_CONFIG;
  const token = env.TOWER_REMOTE_WORKER_TOKEN;
  if (!configPath) throw new Error('TOWER_REMOTE_WORKER_CONFIG is required');
  if (!token) throw new Error('TOWER_REMOTE_WORKER_TOKEN is required');
  const config = loadRemoteWorkbenchWorkerConfig(configPath);
  const server = createRemoteWorkbenchWorkerServer({
    workerId: config.workerId,
    token,
    projects: config.projects,
    projections: config.projections,
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
