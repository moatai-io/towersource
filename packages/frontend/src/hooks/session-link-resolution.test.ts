import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookupSessionLink } from './session-link-resolution';
import type { SessionMeta } from '../stores/session-store';

const session = { id: '11111111-1111-4111-8111-111111111111', shortCode: 'k4m2p9xq' } as SessionMeta;
const reply = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

afterEach(() => vi.unstubAllGlobals());

describe('session link resolution', () => {
  it('checks the server even if a recent row exists; never opens a stale cached session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(403));
    vi.stubGlobal('fetch', fetchMock);
    expect(await lookupSessionLink(session.shortCode!, {})).toEqual({ kind: 'forbidden' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('separates archived links from live sessions without replaying an archived transcript', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { ...session, archived: true })));
    expect(await lookupSessionLink(session.shortCode!, {})).toEqual({ kind: 'archived' });
  });

  it('detects archive-only links on 404, and keeps unknown links distinct', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(404)).mockResolvedValueOnce(reply(200, [session]))
      .mockResolvedValueOnce(reply(404)).mockResolvedValueOnce(reply(200, []));
    vi.stubGlobal('fetch', fetchMock);
    expect(await lookupSessionLink(session.shortCode!, {})).toEqual({ kind: 'archived' });
    expect(await lookupSessionLink('badlink2', {})).toEqual({ kind: 'not_found' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/sessions/archived');
  });

  it('keeps auth and transient failures distinct', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(401)).mockResolvedValueOnce(reply(503)).mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await lookupSessionLink('k4m2p9xq', {})).toEqual({ kind: 'authentication_required' });
    expect(await lookupSessionLink('k4m2p9xq', {})).toEqual({ kind: 'unavailable' });
    expect(await lookupSessionLink('k4m2p9xq', {})).toEqual({ kind: 'unavailable' });
  });
});
