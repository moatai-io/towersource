import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ submit: vi.fn(), status: vi.fn() }));
vi.mock('./client.js', async importOriginal => ({
  ...await importOriginal<typeof import('./client.js')>(),
  feedbackClient: () => ({ submit: mocks.submit, status: mocks.status }),
}));
// Real Claude SDK registration and real Pi schema adapter (not a tool-list mock).
import { createIssueMcpServer } from '../../mcp/issue-server.js';
import { mcpServerToPiTools } from '../../engines/pi-mcp-adapter.js';
const context = { sessionId: 'session-a', userId: 7, username: 'reporter', projectId: 'project-a', cwd: '/synthetic' };
const receipt = { id: '8214b39a-a689-4f8b-b72a-ac82e93519f7', status: 'accepted' };
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('real SDK MCP to Pi feedback registration', () => {
  it('converts the minimal file_issue schema and closure-bound receipt lookup through real SDK', async () => {
    vi.stubEnv('TOWER_FEEDBACK_CLIENT_ENABLED', 'true');
    mocks.submit.mockResolvedValue(receipt); mocks.status.mockResolvedValue(receipt);
    const server = createIssueMcpServer(context);
    try {
      const tools = mcpServerToPiTools({ issue: server });
      const file = tools.find(t => t.name === 'mcp__issue__file_issue')!;
      const status = tools.find(t => t.name === 'mcp__issue__get_feedback_status')!;
      expect(file).toBeDefined(); expect(status).toBeDefined();
      expect(Object.keys(file.parameters.properties)).toEqual(['title', 'body']);
      expect(file.parameters.required).toEqual(['title', 'body']);
      expect(status.parameters.required).toEqual(['receipt_id']);
      const args = { title: 'Synthetic feedback', body: 'Synthetic steps' };
      await file.execute('tool-a', args, undefined);
      expect(mocks.submit).toHaveBeenCalledWith(context, args);
      const result = await status.execute('tool-b', { receipt_id: receipt.id }, undefined);
      expect(mocks.status).toHaveBeenCalledWith(context, receipt.id);
      expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(receipt.id) })]));
    } finally { await server.instance.close(); }
  });
  it('does not advertise receipt status in legacy mode', async () => {
    vi.stubEnv('TOWER_FEEDBACK_CLIENT_ENABLED', 'false');
    const server = createIssueMcpServer(context);
    try {
      const tools = mcpServerToPiTools({ issue: server });
      expect(tools.map(t => t.name)).not.toContain('mcp__issue__get_feedback_status');
      const file = tools.find(t => t.name === 'mcp__issue__file_issue')!;
      expect(Object.keys(file.parameters.properties)).toEqual(['title', 'body']);
      expect(file.parameters.required).toEqual(['title', 'body']);
    }
    finally { await server.instance.close(); }
  });
  it('rejects Pi execution on central failure without leaking raw provider errors', async () => {
    vi.stubEnv('TOWER_FEEDBACK_CLIENT_ENABLED', 'true');
    mocks.submit.mockRejectedValue(new Error('synthetic private provider detail'));
    const server = createIssueMcpServer(context);
    try {
      const file = mcpServerToPiTools({ issue: server }).find(t => t.name === 'mcp__issue__file_issue')!;
      await expect(file.execute('tool-fail', { title: 'Synthetic', body: 'Steps' }, undefined))
        .rejects.toThrow('file_issue failed: feedback_unavailable');
    } finally { await server.instance.close(); }
  });
  it('retains assembly into guarded active tools and orchestrate classification', () => {
    const assembly = readFileSync('packages/backend/engines/pi/tool-assembly.ts', 'utf8');
    expect(assembly).toContain('towerMcpServers.issue = createIssueMcpServer({');
    expect(assembly).toContain('mcpTools = mcpServerToPiTools(towerMcpServers)');
    expect(assembly).toContain('...customTools, ...mcpTools, ...projectMcpTools');
    expect(readFileSync('packages/backend/engines/pi-tool-categories.ts', 'utf8')).toContain("mcp__issue__get_feedback_status: 'orchestrate'");
  });
});
