import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock for @mendable/firecrawl-js so every dynamic import of
// pi-web-tools.ts gets the same mocked client.
const firecrawlMocks = vi.hoisted(() => {
  const scrape = vi.fn();
  const search = vi.fn();
  return { scrape, search };
});

vi.mock('@mendable/firecrawl-js', () => {
  class FirecrawlClient {
    constructor(_opts: any) {}
    scrape = firecrawlMocks.scrape;
    search = firecrawlMocks.search;
  }
  return { FirecrawlClient };
});

beforeEach(() => {
  process.env.FIRECRAWL_API_KEY = 'test-key';
  firecrawlMocks.scrape.mockReset();
  firecrawlMocks.search.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('child_process');
});

describe('Pi web tools (Firecrawl-first)', () => {
  it('WebFetch returns Firecrawl markdown on success', async () => {
    firecrawlMocks.scrape.mockResolvedValue({
      markdown: 'Hello **world**',
      metadata: { title: 'Demo Page' },
    });

    const mod = await import('./pi-web-tools.ts');
    mod.__test__.clearCaches();
    mod.__test__.resetFirecrawl();

    const result = await mod.webFetchTool.execute(
      't1',
      { url: 'https://example.com' },
      undefined as any,
    );
    expect(result.content[0].text).toContain('Demo Page');
    expect(result.content[0].text).toContain('Hello');
    expect(firecrawlMocks.scrape).toHaveBeenCalledOnce();
  });

  it('WebFetch caches identical URLs within the TTL', async () => {
    firecrawlMocks.scrape.mockResolvedValue({ markdown: 'cached body' });

    const mod = await import('./pi-web-tools.ts');
    mod.__test__.clearCaches();
    mod.__test__.resetFirecrawl();

    await mod.webFetchTool.execute('t1', { url: 'https://cached.example' }, undefined as any);
    await mod.webFetchTool.execute('t2', { url: 'https://cached.example' }, undefined as any);

    expect(firecrawlMocks.scrape).toHaveBeenCalledTimes(1);
  });

  it('WebFetch falls back to raw fetch when Firecrawl returns empty', async () => {
    firecrawlMocks.scrape.mockResolvedValue({ markdown: '' });

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (k: string) => k.toLowerCase() === 'content-type' ? 'text/html' : null },
      text: async () => '<html><body><h1>Fallback Page</h1></body></html>',
    })) as any);

    const mod = await import('./pi-web-tools.ts');
    mod.__test__.clearCaches();
    mod.__test__.resetFirecrawl();

    const result = await mod.webFetchTool.execute(
      't3',
      { url: 'https://fallback.example' },
      undefined as any,
    );
    expect(result.content[0].text).toContain('Fallback Page');
  });

  it('WebFetch falls back to curl when Firecrawl throws and fetch throws', async () => {
    firecrawlMocks.scrape.mockRejectedValue(new Error('firecrawl down'));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed'); }) as any);
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn(() =>
        '<html><body><h1>Curl Fallback</h1></body></html>\n__TOWER_META__200|text/html',
      ),
    }));

    const mod = await import('./pi-web-tools.ts');
    mod.__test__.clearCaches();
    mod.__test__.resetFirecrawl();

    const result = await mod.webFetchTool.execute(
      't4',
      { url: 'https://curl.example' },
      undefined as any,
    );
    expect(result.content[0].text).toContain('Curl Fallback');
  });

  it('WebSearch returns Firecrawl web + news results', async () => {
    firecrawlMocks.search.mockResolvedValue({
      web: [
        { title: 'Web Result One', url: 'https://a.example', description: 'snippet A' },
      ],
      news: [
        { title: 'News Item', url: 'https://n.example', snippet: 'news snippet', date: '2026-04-01' },
      ],
    });

    const mod = await import('./pi-web-tools.ts');
    mod.__test__.clearCaches();
    mod.__test__.resetFirecrawl();

    const result = await mod.webSearchTool.execute(
      't5',
      { query: 'tower ai' },
      undefined as any,
    );
    const text = result.content[0].text;
    expect(text).toContain('tower ai');
    expect(text).toContain('Web Result One');
    expect(text).toContain('News Item');
    expect(text).toContain('2026-04-01');
    expect(firecrawlMocks.search).toHaveBeenCalledOnce();
  });

  it('WebSearch reports unavailable when FIRECRAWL_API_KEY is missing', async () => {
    delete process.env.FIRECRAWL_API_KEY;

    const mod = await import('./pi-web-tools.ts');
    mod.__test__.clearCaches();
    mod.__test__.resetFirecrawl();

    const result = await mod.webSearchTool.execute(
      't6',
      { query: 'anything' },
      undefined as any,
    );
    expect(result.content[0].text).toContain('FIRECRAWL_API_KEY');
    expect(firecrawlMocks.search).not.toHaveBeenCalled();
  });

  it('WebSearch surfaces error message on Firecrawl failure', async () => {
    firecrawlMocks.search.mockRejectedValue(new Error('rate limit'));

    const mod = await import('./pi-web-tools.ts');
    mod.__test__.clearCaches();
    mod.__test__.resetFirecrawl();

    const result = await mod.webSearchTool.execute(
      't7',
      { query: 'boom' },
      undefined as any,
    );
    expect(result.content[0].text).toContain('WebSearch failed');
    expect(result.content[0].text).toContain('rate limit');
  });
});
