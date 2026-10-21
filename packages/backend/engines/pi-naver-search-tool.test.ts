import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/gateway-profile/gateway-profile-client.js', () => ({ resolveGatewayApiClient: vi.fn() }));
import { resolveGatewayApiClient } from '../services/gateway-profile/gateway-profile-client.js';
import { createNaverSearchTool } from './pi-naver-search-tool.js';

describe('naver_search Gateway adapter', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(resolveGatewayApiClient).mockResolvedValue({
      profileId: 'tower-shared-api-v1', apiId: 'naver', baseUrl: 'https://gateway.example.com/naver',
      credentialId: 'vm-key', apiKey: 'synthetic-key', readiness: 'ready',
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('routes encoded search through Gateway bearer auth and normalizes markup', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      total: 1, start: 1, display: 1,
      items: [{ title: '<b>타워</b> 뉴스', link: 'https://n.news/1', originallink: 'https://news/1', description: 'A &amp; B', pubDate: 'now' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const tool = createNaverSearchTool({ projectId: 'project-1', userId: 7 });
    const result: any = await tool.execute('call-1', { query: '타워 AI', type: 'news', display: 1, sort: 'date' }, new AbortController().signal, undefined as any);
    expect(resolveGatewayApiClient).toHaveBeenCalledWith({ actorUserId: 7, projectId: 'project-1', apiId: 'naver' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('https://gateway.example.com/naver/search/news.json?');
    expect(String(url)).toContain('query=%ED%83%80%EC%9B%8C+AI');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer synthetic-key');
    expect(result.content[0].text).toContain('타워 뉴스');
    expect(result.content[0].text).not.toContain('<b>');
    expect(result.details).toMatchObject({ apiId: 'naver', gateway: true, itemCount: 1 });
  });

  it('returns a bounded Gateway error without leaking response bodies or keys', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ errorCode: 'SE99', secret: 'do-not-return' }), { status: 502 }));
    const tool = createNaverSearchTool({ projectId: 'project-1', userId: 7 });
    const result: any = await tool.execute('call-2', { query: '테스트' }, new AbortController().signal, undefined as any);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('HTTP 502, code=SE99');
    expect(JSON.stringify(result)).not.toContain('do-not-return');
    expect(JSON.stringify(result)).not.toContain('synthetic-key');
  });
});
