// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { isAllowedDevHostMock } = vi.hoisted(() => ({
  isAllowedDevHostMock: vi.fn(() => false),
}));

vi.mock('../config/dev-hosts', () => ({
  isAllowedDevHost: isAllowedDevHostMock,
}));

import { isChunkLoadError, recoverFromChunkLoadError, reloadForUserUpdate, RELOAD_ONCE_KEY } from './app-version';

beforeEach(() => {
  sessionStorage.clear();
  isAllowedDevHostMock.mockReset();
  isAllowedDevHostMock.mockReturnValue(false);
});

afterEach(() => vi.unstubAllGlobals());

describe('reloadForUserUpdate', () => {
  it('escapes the old service worker even after an automatic recovery and preserves the session URL', async () => {
    sessionStorage.setItem(RELOAD_ONCE_KEY, String(Date.now()));
    const replace = vi.fn();
    vi.stubGlobal('window', { location: { origin: 'https://tower.example.com', pathname: '/s/current', search: '?view=chat', hash: '#message', replace } });

    await reloadForUserUpdate();

    expect(replace).toHaveBeenCalledTimes(1);
    const target = new URL(replace.mock.calls[0][0]);
    expect(target.origin).toBe('https://tower.example.com');
    expect(target.pathname).toBe('/api/client-reset');
    expect(target.searchParams.get('returnTo')).toBe('/s/current?view=chat#message');
  });

  it('routes the root page through the reset escape hatch too', async () => {
    const replace = vi.fn();
    vi.stubGlobal('window', { location: { origin: 'https://tower.example.com', pathname: '/', search: '', hash: '', replace } });
    await reloadForUserUpdate();
    expect(new URL(replace.mock.calls[0][0]).searchParams.get('returnTo')).toBe('/');
  });
});

describe('isChunkLoadError', () => {
  it.each([
    "'text/html' is not a valid JavaScript MIME type.",
    'Failed to fetch dynamically imported module: /assets/MermaidBlock-old.js',
    'Expected a JavaScript-or-Wasm module script but the server responded with text/html',
    'ChunkLoadError: Loading chunk 42 failed',
  ])('recognizes stale lazy chunk errors: %s', (message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
  });

  it('does not classify Mermaid syntax errors as chunk errors', () => {
    expect(isChunkLoadError(new Error('Parse error on line 2'))).toBe(false);
  });
});

describe('recoverFromChunkLoadError', () => {
  it('does not navigate or arm a reload guard on a development host', () => {
    isAllowedDevHostMock.mockReturnValue(true);

    expect(recoverFromChunkLoadError()).toBe(false);
    expect(sessionStorage.getItem(RELOAD_ONCE_KEY)).toBeNull();
  });
});
