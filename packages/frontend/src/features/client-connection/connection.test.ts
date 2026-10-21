// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClientConnection, normalizeServerBase, readBrowserAuthToken, towerHttpUrl, towerWebSocketUrl } from './connection';

afterEach(() => { vi.unstubAllEnvs(); localStorage.clear(); });

describe('Tower client connection boundary', () => {
  it('preserves relative HTTP URLs and the browser WebSocket origin by default', () => {
    const client = createClientConnection('', 'https://tower.example.com');
    expect(client.httpUrl('/api/files?path=a%2Fb')).toBe('/api/files?path=a%2Fb');
    expect(client.webSocketUrl('/ws')).toBe('wss://tower.example.com/ws');
  });
  it('uses the configured server and optional path prefix consistently', () => {
    const client = createClientConnection('https://tower.example.com/team/', 'http://app.localhost');
    expect(client.httpUrl('/api/files')).toBe('https://tower.example.com/team/api/files');
    expect(client.webSocketUrl('/ws?token=a%2Bb')).toBe('wss://tower.example.com/team/ws?token=a%2Bb');
    expect(createClientConnection('http://app.localhost:32355/', 'https://tower.example.com').webSocketUrl('/ws')).toBe('ws://app.localhost:32355/ws');
  });
  it.each([' https://tower.example.com', 'https:foo', 'https://tower.example.com/with space', 'https://tower.example.com\\path', 'javascript:alert(1)', 'file:///tmp/test', '//tower.example.com', 'https://user:pass@tower.example.com', 'https://tower.example.com?token=x', 'https://tower.example.com/#fragment'])('rejects invalid server configuration: %s', value => {
    expect(() => normalizeServerBase(value)).toThrow();
  });
  it.each(['https://other.example.com/api', '//other.example.com/api', '/\\other.example.com/api', '/api\n/x', '/ api', '/api\u0000/x', '/%2e./api', '/../api', '/%2e%2e/api'])('rejects non-Tower or traversing paths: %s', path => {
    const client = createClientConnection('', 'https://tower.example.com');
    expect(() => client.httpUrl(path)).toThrow();
    expect(() => client.webSocketUrl(path)).toThrow();
  });
  it('reads current browser credentials without caching and follows build-time API configuration', () => {
    expect(readBrowserAuthToken()).toBeNull();
    localStorage.setItem('token', 'synthetic-token');
    expect(readBrowserAuthToken()).toBe('synthetic-token');
    vi.stubEnv('VITE_API_URL', 'https://tower.example.com/');
    expect(towerHttpUrl('/api/files')).toBe('https://tower.example.com/api/files');
    expect(towerWebSocketUrl('/ws')).toBe('wss://tower.example.com/ws');
    localStorage.removeItem('token');
    expect(readBrowserAuthToken()).toBeNull();
  });
});
