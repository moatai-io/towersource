import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ submit: vi.fn(), status: vi.fn(), execFile: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (config: unknown) => config,
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}));
vi.mock('child_process', () => ({ execFile: mocks.execFile }));
vi.mock('../services/feedback-intake/client.js', async importOriginal => {
  const original = await importOriginal<typeof import('../services/feedback-intake/client.js')>();
  return { ...original, feedbackClient: () => ({ submit: mocks.submit, status: mocks.status }) };
});
import { createIssueMcpServer, userSafeErrorMessage } from './issue-server.js';
const ctx = { userId: 7, username: 'reporter', sessionId: 'session-a', projectId: 'project-a', cwd: '/not-to-be-forwarded' };
function tools() { return (createIssueMcpServer(ctx) as any).tools as Array<{ name: string; handler: (args: any) => Promise<any> }>; }
const receipt = { id: '8214b39a-a689-4f8b-b72a-ac82e93519f7', status: 'accepted' };
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); });
describe('legacy GitHub issue error classification', () => {
  it.each([
    'GraphQL: Could not resolve to a Repository with the name old-owner/tower.',
    'HTTP 404: Not Found (https://api.github.com/repos/example-org/private-repo)',
    'repository not found',
  ])('maps private repository 404 to an actionable configuration or permission error', raw => {
    expect(userSafeErrorMessage({ stderr: raw })).toBe(
      'Tower issue repository was not found or the VM service credential cannot access it. Ask an operator to verify GITHUB_ISSUE_REPO and private-repository Issues permission.',
    );
  });

  it.each([
    'HTTP 403: Resource not accessible by integration',
    'must have issues write permission',
  ])('maps repository permission failures without exposing provider details', raw => {
    expect(userSafeErrorMessage({ stderr: raw })).toBe(
      'Tower issue service can reach GitHub but lacks permission to use this repository. Ask an operator to grant private-repository Issues write access.',
    );
  });

  it('keeps credential and network failures distinct from repository access failures', () => {
    expect(userSafeErrorMessage({ stderr: 'gh auth login required' })).toContain('credential is not configured');
    expect(userSafeErrorMessage({ stderr: 'could not resolve host github.com' })).toContain('could not reach GitHub');
  });
});

describe('issue MCP central feedback integration', () => {
  it('keeps the original tool set when opt-in is off', () => {
    vi.stubEnv('TOWER_FEEDBACK_CLIENT_ENABLED', 'false');
    expect(tools().map(tool => tool.name)).toEqual(['file_issue', 'get_issue', 'comment_issue']);
  });
  it.each(['false', 'true'])('exposes only title and body on the default file_issue tool (central=%s)', central => {
    vi.stubEnv('TOWER_FEEDBACK_CLIENT_ENABLED', central);
    const file = tools().find(tool => tool.name === 'file_issue') as any;
    expect(Object.keys(file.schema)).toEqual(['title', 'body']);
  });
  it('uses the server-configured repository when legacy file_issue omits repo', async () => {
    vi.stubEnv('TOWER_FEEDBACK_CLIENT_ENABLED', 'false');
    vi.stubEnv('GITHUB_ISSUE_REPO', 'example-org/private-issues');
    mocks.execFile.mockImplementation((_command: string, args: string[], _options: unknown, callback: (error: null, result: { stdout: string; stderr: string }) => void) => {
      if (args[0] === 'api') callback(null, { stdout: 'private\n', stderr: '' });
      else if (args[0] === 'issue' && args[1] === 'create') callback(null, { stdout: 'https://github.com/example-org/private-issues/issues/42\n', stderr: '' });
      else callback(null, { stdout: '', stderr: '' });
      return {};
    });

    const result = await tools().find(tool => tool.name === 'file_issue')!.handler({ title: 'Fallback check', body: 'Synthetic body' });

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('https://github.com/example-org/private-issues/issues/42');
    expect(mocks.execFile).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['issue', 'create', '--repo', 'example-org/private-issues']),
      expect.any(Object),
      expect.any(Function),
    );
  });
  it('routes creation via closure context, returns receipt and never calls gh', async () => {
    vi.stubEnv('TOWER_FEEDBACK_CLIENT_ENABLED', 'true'); mocks.submit.mockResolvedValue(receipt);
    const result = await tools().find(tool => tool.name === 'file_issue')!.handler({ title: 'Feedback', body: 'Steps' });
    expect(mocks.submit).toHaveBeenCalledWith(ctx, { title: 'Feedback', body: 'Steps' });
    expect(result.content[0].text).toContain('아직 완료되지'); expect(mocks.execFile).not.toHaveBeenCalled();
  });
  it('does not fallback to PAT or expose raw error details after central failure', async () => {
    vi.stubEnv('TOWER_FEEDBACK_CLIENT_ENABLED', 'true'); mocks.submit.mockRejectedValue(new Error('synthetic secret error'));
    const result = await tools().find(tool => tool.name === 'file_issue')!.handler({ title: 'Feedback', body: 'Steps' });
    expect(result.isError).toBe(true); expect(result.content[0].text).toBe('file_issue failed: feedback_unavailable');
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
  it('blocks legacy cross-tenant issue read/comment and exposes closure-scoped receipt lookup', async () => {
    vi.stubEnv('TOWER_FEEDBACK_CLIENT_ENABLED', 'true'); mocks.status.mockResolvedValue(receipt);
    for (const name of ['get_issue', 'comment_issue']) {
      const result = await tools().find(tool => tool.name === name)!.handler({ issue_number: 1, body: 'text' });
      expect(result.isError).toBe(true);
    }
    await tools().find(tool => tool.name === 'get_feedback_status')!.handler({ receipt_id: receipt.id });
    expect(mocks.status).toHaveBeenCalledWith(ctx, receipt.id); expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
