// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renameAgentDisplayName } from './rename-agent';

afterEach(() => vi.unstubAllGlobals());
describe('Agent rail rename', () => {
  it('patches only the display name and returns canonical profile metadata', async () => {
    const project = { id: 'agent-a', name: 'storage-name', agent: { displayName: 'New AI', role: 'Research' } };
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => project });
    vi.stubGlobal('fetch', fetcher);
    expect(await renameAgentDisplayName('agent-a', ' New AI ', 'failed')).toEqual(project);
    expect(fetcher).toHaveBeenCalledWith('/api/projects/agent-a/agent-profile', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ displayName: 'New AI' }),
    }));
  });
  it.each([403, 500])('rejects HTTP %s without returning success metadata', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({ error: 'denied' }) }));
    await expect(renameAgentDisplayName('agent-a', 'New AI', 'failed')).rejects.toThrow('failed');
  });
  it('rejects malformed responses and network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => null }));
    await expect(renameAgentDisplayName('agent-a', 'New AI', 'failed')).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(renameAgentDisplayName('agent-a', 'New AI', 'failed')).rejects.toThrow();
  });
  it('uses the displayed name initially and keeps the dialog open on failure', () => {
    const source = readFileSync('packages/frontend/src/components/layout/Sidebar.tsx', 'utf8');
    expect(source).toContain('value: project.agent?.displayName || project.name');
    expect(source).toMatch(/await renameAgentDisplayName[\s\S]*?updateProject\(updatedProject.id, updatedProject\);\s*setAgentRailRename\(null\);\s*} catch \{\s*toastError\(t\('agentRenameFailed'\)\);/);
  });
});
