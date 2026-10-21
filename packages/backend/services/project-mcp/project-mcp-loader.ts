/**
 * project-mcp-loader.ts — project-scoped external MCP manifest loader.
 *
 * Owns: reading `.tower/mcp/manifest.json`, validating safe MCP server
 * definitions, resolving project-granted Credential Vault secrets, and exposing
 * stdio or approved streamable-HTTP MCP servers through a lazy search/call gateway.
 * Public API: createProjectMcpGatewayTools, inspectProjectMcpConfiguration.
 *
 * Design intent: external MCPs must be scoped to a single Tower project and
 * user credential grants. Host-global MCP config is intentionally ignored so
 * admin-installed tools do not leak into member sessions.
 */

import path from 'path';
import { Type } from '@sinclair/typebox';
import Ajv from 'ajv';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { assertProjectMcpExecution } from './project-mcp-access.js';
import { createProjectMcpOAuthProvider } from './project-mcp-oauth.js';
import { projectMcpFetch } from './project-mcp-network.js';
import { readManagedMcpManifest } from './project-mcp-manifest.js';
import { resolveProjectApiKeySecretValue } from '../credential-vault/credential-vault-service.js';

const MANIFEST_RELATIVE_PATH = '.tower/mcp/manifest.json';
const MAX_SERVERS = 8;
const MAX_TOOLS_PER_SERVER = 80;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 8;
const DEFAULT_CALL_TIMEOUT_MS = 45_000;
const MAX_CALL_TIMEOUT_MS = 120_000;
const mcpArgumentsValidator = new Ajv({ strict: false, allErrors: true });

const VALID_SERVER_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const VALID_TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const VALID_ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface ProjectMcpLoadOptions {
  projectRoot?: string;
  projectId?: string;
  userId?: number;
  userRole?: string;
  sessionId: string;
  /** Fresh session-specific opt-out check before discovery and every invocation. */
  isServerAllowed?: (serverName: string) => Promise<boolean>;
}

interface ProjectMcpManifest {
  version?: number;
  servers?: ProjectMcpServerManifest[];
}

export interface ProjectMcpServerManifest {
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
  authType?: 'oauth' | 'none';
  displayName?: string;
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
  if (server.authType !== undefined && !['oauth', 'none'].includes(server.authType)) problems.push(`server[${index}].authType must be oauth or none`);
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

async function readManifest(projectRoot: string): Promise<ProjectMcpManifest> {
  return readManagedMcpManifest(projectRoot);
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
    transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers },
      fetch: projectMcpFetch,
      authProvider: server.authType === 'oauth'
        ? await createProjectMcpOAuthProvider(opts.projectId, server.name, server.url, opts.userId) : undefined,
    });
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

interface ProjectMcpCatalogTool {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  server: MountedProjectMcpServer;
}

function catalogTool(server: MountedProjectMcpServer, tool: any): ProjectMcpCatalogTool | null {
  if (!tool?.name || typeof tool.name !== 'string' || !VALID_TOOL_NAME_RE.test(tool.name)) return null;
  const prefix = normalizeToolPrefix(server.manifest);
  return {
    id: `${prefix}__${sanitizeName(tool.name)}`,
    name: tool.name,
    description: tool.description || `${server.manifest.description || server.manifest.name} MCP tool ${tool.name}`,
    inputSchema: isPlainObject(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
    server,
  };
}

function tokenizeSearchQuery(query: string): string[] {
  return query.toLocaleLowerCase().split(/[^\p{L}\p{N}_.-]+/u).map(token => token.trim()).filter(Boolean);
}

export function rankProjectMcpCatalogTools<T extends Pick<ProjectMcpCatalogTool, 'id' | 'name' | 'description'>>(
  tools: T[],
  query: string,
): T[] {
  const normalized = query.trim().toLocaleLowerCase();
  const tokens = tokenizeSearchQuery(query);
  if (!normalized || tokens.length === 0) return [];
  return tools
    .map(tool => {
      const id = tool.id.toLocaleLowerCase();
      const name = tool.name.toLocaleLowerCase();
      const description = tool.description.toLocaleLowerCase();
      let score = 0;
      if (id === normalized || name === normalized) score += 100;
      if (id.includes(normalized) || name.includes(normalized)) score += 30;
      if (description.includes(normalized)) score += 20;
      for (const token of tokens) {
        if (id.includes(token) || name.includes(token)) score += 8;
        if (description.includes(token)) score += 3;
      }
      return { tool, score };
    })
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.id.localeCompare(b.tool.id))
    .map(candidate => candidate.tool);
}

export interface ProjectMcpConfigurationSummary {
  manifestPath: string;
  manifestPresent: boolean;
  servers: Array<{
    name: string;
    catalogId: string | null;
    type: 'stdio' | 'streamable-http';
    description: string | null;
    enabled: boolean;
    managed: boolean;
    requiredCredentials: string[];
    valid: boolean;
    problems: string[];
  }>;
}

/** Inspect project MCP configuration without starting processes or contacting remote servers. */
export async function inspectProjectMcpConfiguration(projectRoot: string): Promise<ProjectMcpConfigurationSummary> {
  const manifest = await readManifest(projectRoot);
  const declaredServers = manifest?.servers ?? [];
  const agentStoreDeclaration = declaredServers.find(server => server.catalogId === 'agent-store');
  const baselineServers = agentStoreDeclaration
    ? declaredServers
    : [{ name: 'agent-store', catalogId: 'agent-store' }, ...declaredServers];
  return {
    manifestPath: MANIFEST_RELATIVE_PATH,
    manifestPresent: manifest !== null,
    servers: baselineServers.slice(0, MAX_SERVERS).map((declared, index) => {
      const server = applyCatalogDefaults(declared);
      const problems = validateServerManifest(server, index);
      return {
        name: server.name,
        catalogId: server.catalogId ?? null,
        type: server.type ?? 'stdio',
        description: server.description ?? null,
        enabled: server.enabled !== false,
        managed: Boolean(server.catalogId),
        requiredCredentials: (server.secrets ?? []).map(secret => secret.env),
        valid: problems.length === 0,
        problems,
      };
    }),
  };
}

async function currentDefinitions(opts: ProjectMcpLoadOptions): Promise<ProjectMcpServerManifest[]> {
  const manifest = await readManifest(opts.projectRoot!);
  const declared = manifest.servers ?? [];
  return (declared.some(s => s.catalogId === 'agent-store') ? declared : [{ name: 'agent-store', catalogId: 'agent-store' }, ...declared])
    .filter(s => s.enabled !== false).slice(0, MAX_SERVERS).map(applyCatalogDefaults);
}
async function assertRuntimeServerAllowed(opts: ProjectMcpLoadOptions, server: ProjectMcpServerManifest): Promise<void> {
  if (!opts.projectId || !opts.userId || !opts.projectRoot) throw new Error('Agent execution authority required');
  const access = await assertProjectMcpExecution(opts.projectId, opts.userId, opts.projectRoot);
  const privileged = access?.role === 'admin' || access?.role === 'operator';
  if (!privileged && !server.catalogId && (server.type !== 'streamable-http' || server.env || server.headers || server.secrets || server.command || server.args || server.cwd)) throw new Error('Custom process/credential overrides require current admin/operator authority');
  if (opts.isServerAllowed && !await opts.isServerAllowed(server.name)) throw new Error('MCP disabled for session');
  const current = (await currentDefinitions(opts)).find(s => s.name === server.name);
  if (!current || JSON.stringify(current) !== JSON.stringify(server)) throw new Error('MCP configuration changed');
}
async function loadProjectMcpCatalog(opts: ProjectMcpLoadOptions): Promise<ProjectMcpCatalogTool[]> {
  if (!opts.projectRoot || !opts.projectId || !opts.userId) return [];
  const access = await assertProjectMcpExecution(opts.projectId!, opts.userId!, opts.projectRoot);
  const isPrivilegedUser = access?.role === 'admin' || access?.role === 'operator';
  const manifest = await readManifest(opts.projectRoot);
  // Agent Store remains available to every project when its workspace/project
  // credential is available. Availability does not imply eager schema projection.
  const declaredServers = manifest?.servers ?? [];
  const agentStoreDeclaration = declaredServers.find(server => server.catalogId === 'agent-store');
  const baselineServers = agentStoreDeclaration
    ? declaredServers
    : [{ name: 'agent-store', catalogId: 'agent-store' }, ...declaredServers];
  const servers = baselineServers.filter(server => server.enabled !== false).slice(0, MAX_SERVERS).map(applyCatalogDefaults);
  const tools: ProjectMcpCatalogTool[] = [];
  for (let index = 0; index < servers.length; index += 1) {
    const server = servers[index];
    const problems = validateServerManifest(server, index);
    if (problems.length > 0) {
      console.warn(`[project-mcp] invalid server manifest skipped: ${problems.join('; ')}`);
      continue;
    }
    if (!isPrivilegedUser && !server.catalogId && server.type !== 'streamable-http') {
      console.warn(`[project-mcp] custom stdio server ${server.name} skipped: members may only mount approved catalog MCP providers`);
      continue;
    }
    if (!isPrivilegedUser && !server.catalogId && (server.env || server.headers || server.secrets || server.command || server.args || server.cwd)) {
      console.warn(`[project-mcp] skipped ${server.name}: member HTTP connections cannot override credentials or process settings`);
      continue;
    }
    try {
      await assertRuntimeServerAllowed(opts, server);
      const mounted = await mountServer(opts.projectRoot, server, { projectId: opts.projectId, userId: opts.userId });
      const listed = await mounted.client.listTools({}, { timeout: 15_000, maxTotalTimeout: 15_000 });
      for (const tool of (listed.tools ?? []).slice(0, MAX_TOOLS_PER_SERVER)) {
        const entry = catalogTool(mounted, tool);
        if (entry) tools.push(entry);
      }
      console.log(`[project-mcp] cataloged ${server.name}: ${Math.min(listed.tools?.length ?? 0, MAX_TOOLS_PER_SERVER)} tools (deferred)`);
    } catch (err: any) {
      console.warn(`[project-mcp] failed to catalog ${server.name}`);
    }
  }
  return tools;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError, details: undefined };
}

/**
 * Expose a bounded search/call gateway instead of projecting every external MCP
 * tool schema into the model context. The catalog is loaded lazily on first use
 * and reused for the remainder of this tool assembly/session runtime.
 */
export function createProjectMcpGatewayTools(opts: ProjectMcpLoadOptions): ToolDefinition[] {
  if (!opts.projectRoot || !opts.projectId || !opts.userId) return [];
  let catalogPromise: Promise<ProjectMcpCatalogTool[]> | null = null;
  const discoveredToolIds = new Set<string>();
  const getCatalog = () => catalogPromise ??= loadProjectMcpCatalog(opts);

  const searchTool = {
    name: 'mcp_search_tools',
    label: 'Search MCP Tools',
    description: 'Search organization-provided external and domain MCP capabilities without loading every tool schema. Use when a request needs specialized external data or actions not covered by currently visible tools.',
    promptSnippet: 'Search organization-provided MCP capabilities when the request needs a specialized external function that is not currently visible.',
    promptGuidelines: [
      'Use mcp_search_tools when the user asks for a specialized external capability, names a domain data task, asks what integrations can do, or the visible tools cannot perform the request.',
      'Do not search MCP for ordinary conversation, writing, code editing, or work already supported by a visible first-party tool.',
      'Search results are metadata only. Call only a returned tool id with mcp_call_tool.',
    ],
    parameters: Type.Object({
      query: Type.String({ description: 'Natural-language capability to find, such as "아파트 실거래 조회" or "사업자 상태 확인".' }),
      limit: Type.Optional(Type.Number({ description: `Maximum candidates. Default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}.` })),
    }),
    async execute(_toolCallId: string, input: { query: string; limit?: number }) {
      try {
        const catalog = await getCatalog();
        const limit = Math.max(1, Math.min(input.limit || DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT));
        const allowed: ProjectMcpCatalogTool[] = [];
        for (const tool of catalog) {
          try { await assertRuntimeServerAllowed(opts, tool.server.manifest); allowed.push(tool); } catch { /* hide revoked/disabled */ }
        }
        const matches = rankProjectMcpCatalogTools(allowed, input.query).slice(0, limit).map(tool => {
          discoveredToolIds.add(tool.id);
          return {
            id: tool.id,
            description: tool.description,
            inputSchema: tool.inputSchema,
          };
        });
        return textResult(JSON.stringify({ query: input.query, matches, totalCatalogTools: allowed.length }, null, 2));
      } catch (err: any) {
        return textResult('MCP search failed; check Agent connection settings.', true);
      }
    },
  } as unknown as ToolDefinition;

  const callTool = {
    name: 'mcp_call_tool',
    label: 'Call MCP Tool',
    description: 'Call one organization-provided MCP tool by an exact id returned from mcp_search_tools. The server validates arguments against the original MCP schema.',
    promptSnippet: 'Call an MCP capability only after discovering its exact id with mcp_search_tools.',
    promptGuidelines: [
      'Call only an exact tool id returned by mcp_search_tools in this session.',
      'Do not guess tool ids. Search again when the capability or required arguments are unclear.',
      'External writes or destructive actions remain subject to Tower approval and connector policy.',
    ],
    parameters: Type.Object({
      toolId: Type.String({ description: 'Exact id returned by mcp_search_tools.' }),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: 'Arguments matching the inputSchema returned by mcp_search_tools.' })),
    }),
    async execute(_toolCallId: string, input: { toolId: string; arguments?: Record<string, unknown> }, signal: AbortSignal | undefined) {
      try {
        if (!discoveredToolIds.has(input.toolId)) {
          return textResult(`MCP tool was not discovered in this session: ${input.toolId}. Use mcp_search_tools first.`, true);
        }
        const catalog = await getCatalog();
        const tool = catalog.find(candidate => candidate.id === input.toolId);
        if (!tool) return textResult(`MCP tool not found or not available in this project: ${input.toolId}. Use mcp_search_tools again.`, true);
        await assertRuntimeServerAllowed(opts, tool.server.manifest);
        const args = input.arguments ?? {};
        let validArguments = false;
        try {
          validArguments = mcpArgumentsValidator.validate(tool.inputSchema, args);
        } catch {
          return textResult(`MCP tool has an invalid inputSchema and cannot be called safely: ${input.toolId}.`, true);
        }
        if (!validArguments) {
          return textResult(`MCP tool arguments do not match the discovered inputSchema for ${input.toolId}.`, true);
        }
        const timeoutMs = Math.min(Math.max(tool.server.manifest.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, 1_000), MAX_CALL_TIMEOUT_MS);
        const timeout = AbortSignal.timeout(timeoutMs);
        const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const result = await tool.server.client.callTool(
          { name: tool.name, arguments: args },
          undefined,
          { signal: composite, timeout: timeoutMs, maxTotalTimeout: timeoutMs },
        );
        const isError = !!(result as any)?.isError;
        return { content: mapMcpContent((result as any)?.content, isError), isError, details: undefined };
      } catch (err: any) {
        return textResult('MCP call failed; the connection may be disabled or require authentication.', true);
      }
    },
  } as unknown as ToolDefinition;

  return [searchTool, callTool];
}
