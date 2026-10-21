import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  readFile: vi.fn(), connect: vi.fn(), close: vi.fn(), call: vi.fn(),
  list: vi.fn(), allowed: vi.fn(), execution: vi.fn(),
}));
vi.mock('fs/promises', () => ({ default: { readFile: m.readFile } }));
vi.mock('./project-mcp-access.js', () => ({ assertProjectMcpExecution: m.execution }));
vi.mock('./project-mcp-manifest.js', () => ({ readManagedMcpManifest: async () => JSON.parse(await m.readFile()) }));
vi.mock('./project-mcp-oauth.js', () => ({ createProjectMcpOAuthProvider: vi.fn() }));
vi.mock('./project-mcp-network.js', () => ({ projectMcpFetch: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class {
  connect = m.connect; close = m.close; listTools = m.list; callTool = m.call;
} }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {}, getDefaultEnvironment: () => ({}),
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {} }));
vi.mock('../credential-vault/credential-vault-service.js', () => ({ resolveProjectApiKeySecretValue: vi.fn() }));
import { createProjectMcpGatewayTools } from './project-mcp-loader.js';

beforeEach(() => {
  vi.resetAllMocks();
  m.execution.mockResolvedValue({ role: 'admin', rootPath: '/synthetic' });
  m.readFile.mockResolvedValue(JSON.stringify({ version: 1, servers: [
    { name: 'agent-store', catalogId: 'agent-store', enabled: false },
    { name: 'notes', type: 'stdio', command: 'synthetic-mcp-not-executed', description: 'Notes lookup' },
  ] }));
  m.list.mockResolvedValue({ tools: [{ name: 'lookup', description: 'Notes lookup', inputSchema: { type: 'object' } }] });
  m.allowed.mockResolvedValue(true);
  m.call.mockResolvedValue({ content: [{ type: 'text', text: 'synthetic result' }] });
});
function tools() {
  return createProjectMcpGatewayTools({ projectRoot: '/synthetic-project', projectId: 'p', userId: 10, userRole: 'admin', sessionId: 's', isServerAllowed: m.allowed });
}
function payload(result: any) { return JSON.parse(result.content[0].text); }

describe('session selection at deferred MCP gateway boundary', () => {
  it('does not connect or discover an excluded connector', async () => {
    m.allowed.mockResolvedValue(false);
    const search = tools().find(tool => tool.name === 'mcp_search_tools')!;
    const result = payload(await search.execute('search', { query: 'lookup' }));
    expect(result.matches).toEqual([]);
    expect(m.connect).not.toHaveBeenCalled(); expect(m.list).not.toHaveBeenCalled();
  });
  it('rechecks cached search and already-discovered tool ids after opt-out', async () => {
    const gateway = tools();
    const search = gateway.find(tool => tool.name === 'mcp_search_tools')!;
    const call = gateway.find(tool => tool.name === 'mcp_call_tool')!;
    const initial = payload(await search.execute('search1', { query: 'lookup' }));
    expect(initial.matches).toHaveLength(1);
    const toolId = initial.matches[0].id;
    m.allowed.mockResolvedValue(false);
    expect(payload(await search.execute('search2', { query: 'lookup' })).matches).toEqual([]);
    const response = await call.execute('call', { toolId, arguments: {} });
    expect(response.isError).toBe(true);
    expect(m.call).not.toHaveBeenCalled();
  });
  it('blocks a previously discovered id on call even without another search', async () => {
    const gateway = tools();
    const search = gateway.find(tool => tool.name === 'mcp_search_tools')!;
    const call = gateway.find(tool => tool.name === 'mcp_call_tool')!;
    const initial = payload(await search.execute('search', { query: 'lookup' }));
    m.allowed.mockResolvedValue(false);
    const response = await call.execute('call', { toolId: initial.matches[0].id, arguments: {} });
    expect(response.isError).toBe(true);
    expect(m.call).not.toHaveBeenCalled();
  });
  it('never calls through when the live policy lookup fails', async () => {
    const gateway = tools();
    const search = gateway.find(tool => tool.name === 'mcp_search_tools')!;
    const call = gateway.find(tool => tool.name === 'mcp_call_tool')!;
    const initial = payload(await search.execute('search', { query: 'lookup' }));
    m.allowed.mockRejectedValue(new Error('policy store unavailable'));
    const response = await call.execute('call', { toolId: initial.matches[0].id, arguments: {} });
    expect(response.isError).toBe(true);
    expect(m.call).not.toHaveBeenCalled();
  });
  it('permits authorized selected server calls', async () => {
    const gateway = tools();
    const search = gateway.find(tool => tool.name === 'mcp_search_tools')!;
    const call = gateway.find(tool => tool.name === 'mcp_call_tool')!;
    const initial = payload(await search.execute('search', { query: 'lookup' }));
    const response = await call.execute('call', { toolId: initial.matches[0].id, arguments: {} });
    expect(response.content).toEqual([{ type: 'text', text: 'synthetic result' }]);
    expect(m.call).toHaveBeenCalledOnce();
  });
});
