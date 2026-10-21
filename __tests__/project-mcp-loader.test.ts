import { describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

vi.mock('../packages/backend/services/project-mcp/project-mcp-access.js', () => ({
  assertProjectMcpExecution: vi.fn(async (_projectId, userId, projectRoot) => ({
    rootPath: projectRoot, role: userId === 18 ? 'member' : 'admin', membershipRole: 'member',
  })),
}));

vi.mock('../packages/backend/services/credential-vault/credential-vault-service.js', () => ({
  resolveProjectApiKeySecretValue: vi.fn(async () => ({ credentialId: 'agent-store-default', envName: 'AGENT_STORE_API_KEY', value: 'test-secret' })),
  resolveProjectCredentialSecretValue: vi.fn(async () => ({ credentialId: 'agent-store-default', provider: 'agent-store', kind: 'api_key', secretName: 'agent-store-default', value: 'test-secret' })),
}));

const connectMock = vi.fn(async () => undefined);
const listToolsMock = vi.fn(async () => ({
  tools: [{
    name: 'get_series',
    description: 'Get a test series',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  }],
}));
const callToolMock = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class MockClient {
    connect = connectMock;
    listTools = listToolsMock;
    callTool = callToolMock;
  }
  return { Client: MockClient };
});

const transportCtorMock = vi.fn();
const httpTransportCtorMock = vi.fn();
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  class MockStdioClientTransport {
    close = vi.fn();
    constructor(params: any) { transportCtorMock(params); }
  }
  return {
    getDefaultEnvironment: () => ({ PATH: '/usr/bin:/bin' }),
    StdioClientTransport: MockStdioClientTransport,
  };
});
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  class MockStreamableHTTPClientTransport {
    close = vi.fn();
    constructor(url: URL, options: any) { httpTransportCtorMock(url, options); }
  }
  return { StreamableHTTPClientTransport: MockStreamableHTTPClientTransport };
});

async function createGateway(projectRoot: string, userRole: string, sessionId: string) {
  const { createProjectMcpGatewayTools } = await import('../packages/backend/services/project-mcp/project-mcp-loader.js');
  const tools = createProjectMcpGatewayTools({
    projectRoot,
    projectId: '00000000-0000-4000-8000-000000000001',
    userId: userRole === 'member' ? 18 : 1,
    userRole,
    sessionId,
  });
  const search = tools.find(tool => tool.name === 'mcp_search_tools') as any;
  const call = tools.find(tool => tool.name === 'mcp_call_tool') as any;
  expect(tools.map(tool => tool.name)).toEqual(['mcp_search_tools', 'mcp_call_tool']);
  return { search, call };
}

function parseTextResult(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('project-mcp-loader', () => {
  it('discovers and calls the managed Agent Store baseline plus privileged custom stdio tools', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-project-mcp-'));
    await fs.mkdir(path.join(projectRoot, '.tower/mcp'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.tower/mcp/manifest.json'), JSON.stringify({
      version: 1,
      servers: [{
        name: 'bok-stats',
        command: 'agent-store-mcp',
        args: ['bok-stats'],
        secrets: [{ env: 'AGENT_STORE_API_KEY' }],
      }],
    }));

    const { search, call } = await createGateway(projectRoot, 'admin', 's1');
    expect(connectMock).toHaveBeenCalledTimes(0);
    const found = parseTextResult(await search.execute('search-1', { query: 'get_series' }));

    expect(found.matches.map((match: any) => match.id)).toEqual(['agent_store__get_series', 'bok_stats__get_series']);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(transportCtorMock).toHaveBeenCalledWith(expect.objectContaining({
      command: 'agent-store-mcp',
      args: ['bok-stats'],
      cwd: projectRoot,
      env: expect.objectContaining({ PATH: '/usr/bin:/bin', AGENT_STORE_API_KEY: 'test-secret' }),
    }));

    const result = await call.execute('call-1', { toolId: 'bok_stats__get_series', arguments: { query: 'GDP' } });
    expect(result).toEqual(expect.objectContaining({ content: [{ type: 'text', text: 'ok' }], isError: false }));
    expect(callToolMock).toHaveBeenCalledWith(
      { name: 'get_series', arguments: { query: 'GDP' } },
      undefined,
      expect.objectContaining({ timeout: 45_000, maxTotalTimeout: 45_000 }),
    );
  });

  it('keeps the managed baseline but rejects custom stdio commands for members', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-project-mcp-member-'));
    await fs.mkdir(path.join(projectRoot, '.tower/mcp'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.tower/mcp/manifest.json'), JSON.stringify({
      version: 1,
      servers: [{ name: 'bok-stats', command: 'agent-store-mcp', secrets: [{ env: 'AGENT_STORE_API_KEY' }] }],
    }));

    const before = connectMock.mock.calls.length;
    const { search } = await createGateway(projectRoot, 'member', 's2');
    const found = parseTextResult(await search.execute('search-2', { query: 'get_series' }));

    expect(found.matches.map((match: any) => match.id)).toEqual(['agent_store__get_series']);
    expect(connectMock.mock.calls.length).toBe(before + 1);
  });

  it('discovers Agent Store through the approved streamable HTTP gateway with a Vault header', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-project-mcp-catalog-'));

    const before = connectMock.mock.calls.length;
    const { search } = await createGateway(projectRoot, 'member', 's3');
    const found = parseTextResult(await search.execute('search-3', { query: 'test series' }));

    expect(found.matches.map((match: any) => match.id)).toEqual(['agent_store__get_series']);
    expect(connectMock.mock.calls.length).toBe(before + 1);
    expect(httpTransportCtorMock).toHaveBeenCalledWith(
      new URL('https://agent.store/mcp'),
      expect.objectContaining({ requestInit: expect.objectContaining({ headers: expect.any(Headers) }) }),
    );
    const headers = httpTransportCtorMock.mock.calls.at(-1)?.[1]?.requestInit?.headers as Headers;
    expect(headers.get('X-API-Key')).toBe('test-secret');
  });

  it('allows a project manifest to explicitly disable the managed Agent Store baseline', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-project-mcp-disabled-'));
    await fs.mkdir(path.join(projectRoot, '.tower/mcp'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.tower/mcp/manifest.json'), JSON.stringify({
      version: 1,
      servers: [{ name: 'agent-store', catalogId: 'agent-store', enabled: false }],
    }));

    const before = connectMock.mock.calls.length;
    const { search } = await createGateway(projectRoot, 'member', 's4');
    const found = parseTextResult(await search.execute('search-4', { query: 'get_series' }));

    expect(found.matches).toEqual([]);
    expect(found.totalCatalogTools).toBe(0);
    expect(connectMock.mock.calls.length).toBe(before);
  });
});
