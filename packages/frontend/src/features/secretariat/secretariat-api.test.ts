// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSecretariat, parseSecretariatSnapshot, readSecretariatProposal, updateSecretariatEnabled } from './secretariat-api';

const data = { enabled: false, pausedReason: null, proposals: [] };
const fetchMock = vi.fn();
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('secretariat account API boundary', () => {
  it('accepts the agreed response and drops unrelated top-level fields', () => {
    expect(parseSecretariatSnapshot({ ...data, extra: 'irrelevant' })).toEqual(data);
  });

  it.each([null, {}, { ...data, enabled: 'false' }, { ...data, pausedReason: undefined }, { ...data, proposals: 'not-an-array' }, { ...data, proposals: [{}] }])('rejects malformed state instead of enabling by coercion: %j', (value) => {
    expect(() => parseSecretariatSnapshot(value)).toThrow();
  });

  it('supports nullable source identifiers and actual proposal payloads', () => {
    const proposal = { id: 'p', title: 'Title', body: 'Body', createdAt: 'now', readAt: null, sessionId: null, projectId: null };
    expect(parseSecretariatSnapshot({ ...data, proposals: [proposal] }).proposals).toEqual([proposal]);
    expect(() => parseSecretariatSnapshot({ ...data, proposals: [{ ...proposal, body: null }] })).toThrow();
  });

  it('URL-encodes proposal IDs and supports mutation responses with no body', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 });
    await readSecretariatProposal('id/with space');
    await updateSecretariatEnabled(false);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/secretariat/proposals/id%2Fwith%20space/read');
    expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":false}' }));
  });

  it('rejects unsuccessful fetches', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    await expect(loadSecretariat()).rejects.toThrow('401');
  });

  it('uses configured API origin and passes a cancellation signal', async () => {
    vi.stubEnv('VITE_API_URL', 'https://tower.example.com');
    vi.resetModules();
    const api = await import('./secretariat-api');
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => data });
    const controller = new AbortController();
    await api.loadSecretariat(controller.signal);
    expect(fetchMock).toHaveBeenCalledWith('https://tower.example.com/api/secretariat', expect.objectContaining({ signal: controller.signal }));
  });
});
