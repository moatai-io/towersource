import { describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

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

describe('project-mcp-loader', () => {
  it('mounts the managed Agent Store baseline plus privileged custom stdio tools', async () => {
    const { loadProjectMcpTools } = await import('../packages/backend/services/project-mcp/project-mcp-loader.js');
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

    const tools = await loadProjectMcpTools({
      projectRoot,
      projectId: '00000000-0000-4000-8000-000000000001',
      userId: 1,
      userRole: 'admin',
      sessionId: 's1',
    });

    expect(tools.map(t => t.name)).toEqual(['agent_store__get_series', 'bok_stats__get_series']);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(transportCtorMock).toHaveBeenCalledWith(expect.objectContaining({
      command: 'agent-store-mcp',
      args: ['bok-stats'],
      cwd: projectRoot,
      env: expect.objectContaining({ PATH: '/usr/bin:/bin', AGENT_STORE_API_KEY: 'test-secret' }),
    }));
  });

  it('keeps the managed baseline but rejects custom stdio commands for members', async () => {
    const { loadProjectMcpTools } = await import('../packages/backend/services/project-mcp/project-mcp-loader.js');
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-project-mcp-member-'));
    await fs.mkdir(path.join(projectRoot, '.tower/mcp'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.tower/mcp/manifest.json'), JSON.stringify({
      version: 1,
      servers: [{ name: 'bok-stats', command: 'agent-store-mcp', secrets: [{ env: 'AGENT_STORE_API_KEY' }] }],
    }));

    const before = connectMock.mock.calls.length;
    const tools = await loadProjectMcpTools({
      projectRoot,
      projectId: '00000000-0000-4000-8000-000000000001',
      userId: 18,
      userRole: 'member',
      sessionId: 's2',
    });

    expect(tools.map(t => t.name)).toEqual(['agent_store__get_series']);
    expect(connectMock.mock.calls.length).toBe(before + 1);
  });

  it('mounts Agent Store through the approved streamable HTTP gateway with a Vault header', async () => {
    const { loadProjectMcpTools } = await import('../packages/backend/services/project-mcp/project-mcp-loader.js');
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-project-mcp-catalog-'));

    const before = connectMock.mock.calls.length;
    const tools = await loadProjectMcpTools({
      projectRoot,
      projectId: '00000000-0000-4000-8000-000000000001',
      userId: 18,
      userRole: 'member',
      sessionId: 's3',
    });

    expect(tools.map(t => t.name)).toEqual(['agent_store__get_series']);
    expect(connectMock.mock.calls.length).toBe(before + 1);
    expect(httpTransportCtorMock).toHaveBeenCalledWith(
      new URL('https://agent.store/mcp'),
      expect.objectContaining({ requestInit: expect.objectContaining({ headers: expect.any(Headers) }) }),
    );
    const headers = httpTransportCtorMock.mock.calls.at(-1)?.[1]?.requestInit?.headers as Headers;
    expect(headers.get('X-API-Key')).toBe('test-secret');
  });

  it('allows a project manifest to explicitly disable the managed Agent Store baseline', async () => {
    const { loadProjectMcpTools } = await import('../packages/backend/services/project-mcp/project-mcp-loader.js');
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-project-mcp-disabled-'));
    await fs.mkdir(path.join(projectRoot, '.tower/mcp'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.tower/mcp/manifest.json'), JSON.stringify({
      version: 1,
      servers: [{ name: 'agent-store', catalogId: 'agent-store', enabled: false }],
    }));

    const before = connectMock.mock.calls.length;
    const tools = await loadProjectMcpTools({
      projectRoot,
      projectId: '00000000-0000-4000-8000-000000000001',
      userId: 18,
      userRole: 'member',
      sessionId: 's4',
    });

    expect(tools).toEqual([]);
    expect(connectMock.mock.calls.length).toBe(before);
  });
});
