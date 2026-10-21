/** Managed manifest edits use an atomic rename, preserve unknown fields, and refuse symlink traversal. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectMcpServerManifest } from './project-mcp-loader.js';
const queues = new Map<string, Promise<unknown>>();
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
export function assertMcpServerName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error('Invalid MCP server name');
}
export async function safeMcpManifestPath(root: string, create = false): Promise<string> {
  const resolved = await fs.realpath(root);
  // Registered root may itself be a platform symlink; descendants must be real directories/files.
  let dir = resolved;
  for (const segment of ['.tower', 'mcp']) {
    dir = path.join(dir, segment);
    if (create) await fs.mkdir(dir, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    try {
      const stat = await fs.lstat(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe MCP manifest directory');
    } catch (e: any) { if (e.code !== 'ENOENT' || create) throw e; }
  }
  const file = path.join(dir, 'manifest.json');
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 128 * 1024) throw new Error('Unsafe MCP manifest file');
  } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  return file;
}
export async function readManagedMcpManifest(root: string): Promise<{ version?: number; servers: ProjectMcpServerManifest[]; [key: string]: unknown }> {
  const file = await safeMcpManifestPath(root);
  let value: any;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e: any) { if (e.code === 'ENOENT') return { version: 1, servers: [] }; throw new Error('Invalid MCP manifest'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.servers) || value.servers.length > 8) throw new Error('Invalid MCP manifest');
  return value;
}
export async function mutateMcpManifest(root: string, mutate: (servers: ProjectMcpServerManifest[]) => ProjectMcpServerManifest[]): Promise<void> {
  const key = await fs.realpath(root);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const value = await readManagedMcpManifest(root);
    const servers = mutate(value.servers);
    if (servers.length > 8) throw new Error('Agent MCP limit is eight connections');
    const file = await safeMcpManifestPath(root, true);
    const tmp = path.join(path.dirname(file), `.manifest-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(tmp, JSON.stringify({ ...value, version: value.version ?? 1, servers }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await fs.rename(tmp, file);
    } finally { await fs.unlink(tmp).catch(() => {}); }
  });
  queues.set(key, next);
  try { await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
