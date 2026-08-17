/**
 * project-mcp-loader.ts — project-scoped external MCP manifest loader.
 *
 * Owns: reading `.tower/mcp/manifest.json`, validating safe MCP server
 * definitions, resolving project-granted Credential Vault secrets, and exposing
 * stdio or approved streamable-HTTP MCP servers as Pi ToolDefinition objects.
 * Public API: loadProjectMcpTools.
 *
 * Design intent: external MCPs must be scoped to a single Tower project and
 * user credential grants. Host-global MCP config is intentionally ignored so
 * admin-installed tools do not leak into member sessions.
 */

import fs from 'fs/promises';
import path from 'path';
import { Type, type TSchema } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolveProjectApiKeySecretValue } from '../credential-vault/credential-vault-service.js';

const MANIFEST_RELATIVE_PATH = '.tower/mcp/manifest.json';
const MAX_SERVERS = 8;
const MAX_TOOLS_PER_SERVER = 80;
const DEFAULT_CALL_TIMEOUT_MS = 45_000;
const MAX_CALL_TIMEOUT_MS = 120_000;

const VALID_SERVER_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const VALID_TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const VALID_ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface ProjectMcpLoadOptions {
  projectRoot?: string;
  projectId?: string;
  userId?: number;
  userRole?: string;
  sessionId: string;
}

interface ProjectMcpManifest {
  version?: number;
  servers?: ProjectMcpServerManifest[];
}

interface ProjectMcpServerManifest {
  name: string;
  type?: 'stdio' | 'streamable-http';
  /** Optional admin-curated provider id. Members may mount catalog entries but not arbitrary commands. */
  catalogId?: string;
  /** Required for custom stdio servers; provided by catalog entries for approved providers. */
  command?: string;
  args?: string[];
  /** Required for streamable HTTP servers. Catalog entries provide approved URLs. */
  url?: string;
  cwd?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  secrets?: Array<{ env: string; credentialId?: string; header?: string }>;
  toolNamePrefix?: string;
  enabled?: boolean;
  description?: string;
  timeoutMs?: number;
}

interface ProjectMcpCatalogEntry {
  id: string;
  type: 'stdio' | 'streamable-http';
  command?: string;
  args?: string[];
  url?: string;
  secrets?: Array<{ env: string; credentialId?: string; header?: string }>;
  toolNamePrefix?: string;
  description?: string;
}

const PROJECT_MCP_CATALOG: Record<string, ProjectMcpCatalogEntry> = {
  // Agent Store is an official remote streamable-HTTP MCP gateway. Keeping the
  // URL in the curated catalog prevents project manifests from redirecting a
  // workspace credential to an arbitrary host.
  'agent-store': {
    id: 'agent-store',
    type: 'streamable-http',
    url: 'https://agent.store/mcp',
    secrets: [{ env: 'AGENT_STORE_API_KEY', header: 'X-API-Key' }],
    toolNamePrefix: 'agent_store',
    description: 'Agent Store project-scoped data MCP',
  },
};

interface MountedProjectMcpServer {
  manifest: ProjectMcpServerManifest;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeName(input: string): string {
  return input.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128) || 'tool';
}

function normalizeToolPrefix(server: ProjectMcpServerManifest): string {
  const raw = server.toolNamePrefix || server.name;
  return sanitizeName(raw).replace(/[.-]/g, '_');
}

function resolveProjectRelativePath(projectRoot: string, relativeOrAbsolute: string | undefined): string | undefined {
  if (!relativeOrAbsolute) return undefined;
  const resolved = path.isAbsolute(relativeOrAbsolute)
    ? path.normalize(relativeOrAbsolute)
    : path.resolve(projectRoot, relativeOrAbsolute);
  const normalizedRoot = path.resolve(projectRoot);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw new Error(`project MCP cwd escapes project root: ${relativeOrAbsolute}`);
  }
  return resolved;
}

function applyCatalogDefaults(server: ProjectMcpServerManifest): ProjectMcpServerManifest {
  if (!server.catalogId) return server;
  const catalog = PROJECT_MCP_CATALOG[server.catalogId];
  if (!catalog) return server;
  return {
    ...server,
    type: catalog.type,
    command: catalog.command,
    args: server.args ?? catalog.args,
    url: catalog.url,
    secrets: server.secrets ?? catalog.secrets,
    toolNamePrefix: server.toolNamePrefix ?? catalog.toolNamePrefix,
    description: server.description ?? catalog.description,
  };
}

function validateServerManifest(server: ProjectMcpServerManifest, index: number): string[] {
  const problems: string[] = [];
  if (!server || typeof server !== 'object') return [`server[${index}] must be an object`];
  if (!server.name || typeof server.name !== 'string' || !VALID_SERVER_NAME_RE.test(server.name)) {
    problems.push(`server[${index}].name must match ${VALID_SERVER_NAME_RE}`);
  }
  if (server.catalogId && !PROJECT_MCP_CATALOG[server.catalogId]) problems.push(`server[${index}].catalogId is not in the approved project MCP catalog`);
  if (server.type && server.type !== 'stdio' && server.type !== 'streamable-http') problems.push(`server[${index}].type must be "stdio" or "streamable-http"`);
  if ((server.type ?? 'stdio') === 'stdio' && (!server.command || typeof server.command !== 'string')) problems.push(`server[${index}].command is required for stdio`);
  if (server.type === 'streamable-http' && (!server.url || !server.url.startsWith('https://'))) problems.push(`server[${index}].url must be an https URL`);
  if (server.command && (server.command.includes('/') || server.command.includes('\\'))) {
    problems.push(`server[${index}].command must be a PATH executable name, not a path`);
  }
  if (server.args && (!Array.isArray(server.args) || server.args.some(arg => typeof arg !== 'string'))) {
    problems.push(`server[${index}].args must be an array of strings`);
  }
  if (server.env && (!isPlainObject(server.env) || Object.keys(server.env).some(k => !VALID_ENV_NAME_RE.test(k)))) {
    problems.push(`server[${index}].env keys must be UPPER_SNAKE names`);
  }
  if (server.secrets && (!Array.isArray(server.secrets) || server.secrets.some(s => !s || typeof s !== 'object' || typeof s.env !== 'string' || !VALID_ENV_NAME_RE.test(s.env) || (s.header !== undefined && typeof s.header !== 'string')))) {
    problems.push(`server[${index}].secrets entries must include env: UPPER_SNAKE`);
  }
  return problems;
}

async function readManifest(projectRoot: string): Promise<ProjectMcpManifest | null> {
  const manifestPath = path.join(projectRoot, MANIFEST_RELATIVE_PATH);
  let text: string;
  try {
    text = await fs.readFile(manifestPath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(text) as unknown;
  if (!isPlainObject(parsed)) throw new Error('project MCP manifest must be a JSON object');
  return parsed as ProjectMcpManifest;
}

async function resolveServerEnv(server: ProjectMcpServerManifest, opts: Required<Pick<ProjectMcpLoadOptions, 'projectId' | 'userId'>>): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    ...(server.env ?? {}),
  };
  for (const secret of server.secrets ?? []) {
    const resolved = secret.credentialId
      ? await import('../credential-vault/credential-vault-service.js').then(m => m.resolveProjectCredentialSecretValue({
          projectId: opts.projectId,
          userId: opts.userId,
          credentialId: secret.credentialId!,
          kind: 'api_key',
          targetType: 'project-mcp',
        })).then(r => r ? { value: r.value } : null)
      : await resolveProjectApiKeySecretValue({
          projectId: opts.projectId,
          userId: opts.userId,
          envName: secret.env,
          targetType: 'project-mcp',
        });
    if (!resolved) {
      throw new Error(`project MCP server ${server.name} requires unavailable credential for ${secret.env}`);
    }
    env[secret.env] = resolved.value;
  }
  return env;
}

function schemaToTypeBox(inputSchema: unknown): TSchema {
  const schema = isPlainObject(inputSchema) ? inputSchema : { type: 'object', properties: {} };
  return Type.Unsafe<unknown>(schema) as TSchema;
}

function mapMcpContent(content: any[] | undefined, isError: boolean) {
  const out: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') out.push({ type: 'text', text: block.text });
    else if (block?.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') out.push({ type: 'image', data: block.data, mimeType: block.mimeType });
    else out.push({ type: 'text', text: JSON.stringify(block) });
  }
  if (out.length === 0) out.push({ type: 'text', text: isError ? '[Project MCP tool returned error with no content]' : '[Project MCP tool returned no content]' });
  return out;
}

async function mountServer(projectRoot: string, server: ProjectMcpServerManifest, opts: Required<Pick<ProjectMcpLoadOptions, 'projectId' | 'userId'>>): Promise<MountedProjectMcpServer> {
  const resolvedSecrets = await resolveServerEnv(server, opts);
  const cwd = resolveProjectRelativePath(projectRoot, server.cwd) ?? projectRoot;
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  if (server.type === 'streamable-http') {
    if (!server.url) throw new Error(`project MCP server ${server.name} has no URL after validation`);
    const headers = new Headers(server.headers ?? {});
    for (const secret of server.secrets ?? []) {
      if (secret.header) headers.set(secret.header, resolvedSecrets[secret.env]);
    }
    transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } });
  } else {
    if (!server.command) throw new Error(`project MCP server ${server.name} has no command after validation`);
    transport = new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: { ...getDefaultEnvironment(), ...resolvedSecrets },
      cwd,
      stderr: 'pipe',
    });
  }
  const client = new Client({ name: `tower-project-mcp-${server.name}`, version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return { manifest: server, client, transport };
}

function makeTool(server: MountedProjectMcpServer, tool: any): ToolDefinition | null {
  if (!tool?.name || typeof tool.name !== 'string' || !VALID_TOOL_NAME_RE.test(tool.name)) return null;
  const prefix = normalizeToolPrefix(server.manifest);
  const piToolName = `${prefix}__${sanitizeName(tool.name)}`;
  const timeoutMs = Math.min(Math.max(server.manifest.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, 1_000), MAX_CALL_TIMEOUT_MS);
  return {
    name: piToolName,
    label: piToolName,
    description: tool.description || `${server.manifest.description || server.manifest.name} MCP tool ${tool.name}`,
    parameters: schemaToTypeBox(tool.inputSchema),
    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const result = await server.client.callTool({ name: tool.name, arguments: params ?? {} }, undefined, { signal: composite, timeout: timeoutMs, maxTotalTimeout: timeoutMs });
        const isError = !!(result as any)?.isError;
        return { content: mapMcpContent((result as any)?.content, isError), details: undefined };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `[Project MCP tool error] ${piToolName}: ${err?.message || String(err)}` }], details: undefined };
      }
    },
  } as ToolDefinition;
}

/**
 * Load project-scoped MCP tools. Agent Store is a managed baseline when its
 * project credential policy allows access; a manifest can explicitly disable it.
 */
export async function loadProjectMcpTools(opts: ProjectMcpLoadOptions): Promise<ToolDefinition[]> {
  if (!opts.projectRoot || !opts.projectId || !opts.userId) return [];
  const isPrivilegedUser = opts.userRole === 'admin' || opts.userRole === 'operator';
  const manifest = await readManifest(opts.projectRoot);
  // Agent Store is the managed baseline whenever its project credential policy
  // allows access. A project manifest may explicitly disable it by declaring an
  // agent-store catalog entry with enabled=false.
  const declaredServers = manifest?.servers ?? [];
  const agentStoreDeclaration = declaredServers.find(server => server.catalogId === 'agent-store');
  const baselineServers = agentStoreDeclaration
    ? declaredServers
    : [{ name: 'agent-store', catalogId: 'agent-store' }, ...declaredServers];
  const servers = baselineServers.filter(server => server.enabled !== false).slice(0, MAX_SERVERS).map(applyCatalogDefaults);
  const tools: ToolDefinition[] = [];
  for (let index = 0; index < servers.length; index += 1) {
    const server = servers[index];
    const problems = validateServerManifest(server, index);
    if (problems.length > 0) {
      console.warn(`[project-mcp] invalid server manifest skipped: ${problems.join('; ')}`);
      continue;
    }
    if (!isPrivilegedUser && !server.catalogId) {
      console.warn(`[project-mcp] custom stdio server ${server.name} skipped: members may only mount approved catalog MCP providers`);
      continue;
    }
    try {
      const mounted = await mountServer(opts.projectRoot, server, { projectId: opts.projectId, userId: opts.userId });
      const listed = await mounted.client.listTools({}, { timeout: 15_000, maxTotalTimeout: 15_000 });
      for (const tool of (listed.tools ?? []).slice(0, MAX_TOOLS_PER_SERVER)) {
        const piTool = makeTool(mounted, tool);
        if (piTool) tools.push(piTool);
      }
      console.log(`[project-mcp] mounted ${server.name}: ${Math.min(listed.tools?.length ?? 0, MAX_TOOLS_PER_SERVER)} tools`);
    } catch (err: any) {
      console.warn(`[project-mcp] failed to mount ${server.name}: ${err?.message || String(err)}`);
    }
  }
  return tools;
}
