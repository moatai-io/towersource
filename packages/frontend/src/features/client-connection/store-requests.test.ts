// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../stores/session-store';
import { useProjectStore } from '../../stores/project-store';
import { patchSessionModel, confirmEngineSwitch } from '../../stores/engine-pick';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_API_URL', 'https://tower.example.com/');
  localStorage.setItem('token', 'synthetic-store-token');
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, state: { subscribed: true } }) });
  useSessionStore.setState({ sessions: [], hydratedProjectSessionIds: new Set(), projectSessionsLoading: new Set() });
  useProjectStore.setState({ projects: [] });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); localStorage.clear(); });

describe('store requests use the Tower connection boundary', () => {
  it.each(['', 'https://tower.example.com/'])('hydrates sessions with configured base %s', async base => {
    vi.stubEnv('VITE_API_URL', base);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await useSessionStore.getState().hydrateProjectSessions('project a');
    expect(fetchMock).toHaveBeenCalledWith(`${base.replace(/\/$/, '')}/api/sessions?projectId=project+a`, {
      headers: { Authorization: 'Bearer synthetic-store-token' },
    });
  });
  it('preserves subscription and read request methods, bodies and auth', async () => {
    await useSessionStore.getState().setSessionSubscription('session-1', true);
    await useSessionStore.getState().markAiResponseRead('session-1', 4);
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://tower.example.com/api/sessions/session-1/subscription', expect.objectContaining({ method: 'PUT', body: '{"subscribed":true}', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-store-token' } }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://tower.example.com/api/sessions/session-1/read-ai-response', expect.objectContaining({ method: 'PUT', body: '{"sequence":4}' }));
  });
  it('keeps model patch and guarded engine switch on the configured server', async () => {
    await patchSessionModel('session-1', { modelUsed: 'preset/core' });
    await confirmEngineSwitch('session-1', 'pi');
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://tower.example.com/api/sessions/session-1', expect.objectContaining({ method: 'PATCH', body: '{"modelUsed":"preset/core"}' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://tower.example.com/api/sessions/session-1/switch-engine', expect.objectContaining({ method: 'POST' }));
  });
  it('persists project pins without altering the payload', () => {
    useProjectStore.setState({ projects: [{ id: 'project-1', name: 'Example', pinned: false } as any] });
    useProjectStore.getState().pinProject('project-1');
    expect(fetchMock).toHaveBeenCalledWith('https://tower.example.com/api/projects/pins', expect.objectContaining({ method: 'PUT', body: '{"projectIds":["project-1"]}' }));
  });
  it('preserves failure return values and thrown model errors', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'RUNNING' } }) });
    expect(await useSessionStore.getState().setSessionSubscription('session-1', true)).toBe(false);
    await expect(patchSessionModel('session-1', { modelUsed: 'preset/core' })).rejects.toThrow('409');
    expect(await confirmEngineSwitch('session-1', 'pi')).toMatchObject({ ok: false, status: 409, error: { code: 'RUNNING' } });
  });
});
