import { execFileSync } from 'child_process';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { FirecrawlClient } from '@mendable/firecrawl-js';

/**
 * PI web tools — Firecrawl-first.
 *
 * WebFetch  : Firecrawl scrape (markdown) → curl fallback → stripHtml
 * WebSearch : Firecrawl search (web + news) → no fallback (DuckDuckGo Instant
 *             Answer was effectively useless for real queries).
 *
 * Design notes:
 *  - In-memory cache: same (url|query) re-call within TTL returns cached text.
 *    Resets on backend restart; good enough for a single PI session burst.
 *  - Per-process rate guard: hard cap on concurrent Firecrawl calls to avoid
 *    runaway credit spend if the agent loops.
 *  - If FIRECRAWL_API_KEY is missing, the tools still function via fallback
 *    paths (scrape → curl; search → error message explaining the setup).
 */

const WebFetchParams = Type.Object({
  url: Type.String({ description: 'URL to fetch and read' }),
});

const WebSearchParams = Type.Object({
  query: Type.String({ description: 'Search query to look up on the web' }),
});

// ---------- Firecrawl singleton ----------

let firecrawlSingleton: FirecrawlClient | null = null;
let firecrawlInitFailed = false;

export interface PiWebToolContext {
  userId?: number;
  projectId?: string;
}

function getFirecrawl(): FirecrawlClient | null {
  if (firecrawlSingleton) return firecrawlSingleton;
  if (firecrawlInitFailed) return null;
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    firecrawlInitFailed = true;
    return null;
  }
  try {
    firecrawlSingleton = new FirecrawlClient({ apiKey });
    return firecrawlSingleton;
  } catch {
    firecrawlInitFailed = true;
    return null;
  }
}

async function resolveFirecrawl(ctx: PiWebToolContext | undefined, targetType: string): Promise<FirecrawlClient | null> {
  const envClient = getFirecrawl();
  if (envClient) return envClient;
  if (!ctx?.projectId || !ctx.userId) return null;

  const { resolveProjectApiKeySecretValue } = await import('../services/credential-vault/credential-vault-service.js');
  const resolved = await resolveProjectApiKeySecretValue({
    projectId: ctx.projectId,
    userId: ctx.userId,
    envName: 'FIRECRAWL_API_KEY',
    targetType,
  });
  if (!resolved?.value) return null;
  return new FirecrawlClient({ apiKey: resolved.value });
}

// ---------- Cache + rate guard ----------

interface CacheEntry { text: string; ts: number }
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const fetchCache = new Map<string, CacheEntry>();
const searchCache = new Map<string, CacheEntry>();

function cacheGet(map: Map<string, CacheEntry>, key: string): string | null {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    map.delete(key);
    return null;
  }
  return hit.text;
}

function cacheSet(map: Map<string, CacheEntry>, key: string, text: string): void {
  map.set(key, { text, ts: Date.now() });
  // Naive eviction: keep cache bounded.
  if (map.size > 200) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
}

const MAX_INFLIGHT = 4;
let inflight = 0;
async function withInflight<T>(fn: () => Promise<T>): Promise<T> {
  while (inflight >= MAX_INFLIGHT) {
    await new Promise((r) => setTimeout(r, 50));
  }
  inflight += 1;
  try {
    return await fn();
  } finally {
    inflight -= 1;
  }
}

// ---------- HTML helpers (fallback path) ----------

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string, max = 6000): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

async function fetchWithTimeout(url: string, timeoutMs = 15000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: ac.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TowerBot/1.0; +https://tower.tower.example.com)',
        'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function curlFetch(url: string, timeoutSeconds = 15): { status: number; contentType: string; body: string } {
  const output = execFileSync('curl', [
    '-sSL',
    '--max-time', String(timeoutSeconds),
    '-A', 'Mozilla/5.0 (compatible; TowerBot/1.0; +https://tower.tower.example.com)',
    '-H', 'Accept: text/html,application/json;q=0.9,*/*;q=0.8',
    '-w', '\n__TOWER_META__%{http_code}|%{content_type}',
    url,
  ], {
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
  });

  const marker = '\n__TOWER_META__';
  const idx = output.lastIndexOf(marker);
  if (idx === -1) {
    return { status: 200, contentType: '', body: output };
  }
  const body = output.slice(0, idx);
  const meta = output.slice(idx + marker.length).trim();
  const [statusStr, contentType = ''] = meta.split('|', 2);
  return {
    status: Number(statusStr) || 0,
    contentType,
    body,
  };
}

async function fallbackFetch(url: string): Promise<{ status: number; contentType: string; body: string }> {
  try {
    const response = await fetchWithTimeout(url);
    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();
    return { status: response.status, contentType, body };
  } catch {
    return curlFetch(url);
  }
}

function fallbackToText({ status, contentType, body }: { status: number; contentType: string; body: string }): string {
  if (status < 200 || status >= 300) {
    return `Fetch failed: HTTP ${status}${body ? ` — ${body.slice(0, 200)}` : ''}`;
  }
  if (contentType.includes('application/json')) {
    try {
      return truncate(JSON.stringify(JSON.parse(body), null, 2));
    } catch {
      return truncate(body);
    }
  }
  return truncate(stripHtml(body) || '(No readable text found)');
}

// ---------- Firecrawl scrape (primary) ----------

async function firecrawlScrape(url: string, ctx?: PiWebToolContext): Promise<string | null> {
  const client = await resolveFirecrawl(ctx, 'pi_web_fetch');
  if (!client) return null;
  try {
    const doc = await withInflight(() =>
      client.scrape(url, {
        formats: ['markdown'],
        onlyMainContent: true,
        timeout: 20000,
      } as any),
    );
    const markdown = (doc as any)?.markdown as string | undefined;
    if (markdown && markdown.trim().length > 0) {
      const title = (doc as any)?.metadata?.title as string | undefined;
      const header = title ? `# ${title}\n\n` : '';
      return truncate(header + markdown);
    }
    return null;
  } catch (err: any) {
    return `__FIRECRAWL_ERROR__:${err?.message || 'unknown'}`;
  }
}

// ---------- WebFetch tool ----------

export function createWebFetchTool(ctx?: PiWebToolContext): ToolDefinition {
  return {
    name: 'WebFetch',
    label: 'Fetch Page',
    description: 'Fetch a web page or JSON endpoint and return readable text content (Firecrawl-powered).',
    promptSnippet: 'Read content from a URL when a web page or API response is needed.',
    promptGuidelines: [
      'Use WebFetch when you need to read the contents of a specific URL.',
      'Prefer WebFetch for direct page reads over guessing from memory.',
      'Firecrawl handles JS-rendered pages and bot-blocked news sites.',
      'Summarize large responses and keep only the most relevant text.',
    ],
    parameters: WebFetchParams,
    async execute(_toolCallId: string, params: { url: string }) {
      const url = params.url;

      // Cache
      const cached = cacheGet(fetchCache, url);
      if (cached) {
        return { content: [{ type: 'text' as const, text: cached }], details: undefined };
      }

      // 1) Firecrawl primary
      const fc = await firecrawlScrape(url, ctx);
      if (fc && !fc.startsWith('__FIRECRAWL_ERROR__')) {
        cacheSet(fetchCache, url, fc);
        return { content: [{ type: 'text' as const, text: fc }], details: undefined };
      }

      // 2) Raw fetch / curl fallback
      try {
        const raw = await fallbackFetch(url);
        const text = fallbackToText(raw);
        if (!text.startsWith('Fetch failed')) {
          cacheSet(fetchCache, url, text);
        }
        const firecrawlNote = fc?.startsWith('__FIRECRAWL_ERROR__')
          ? ` (firecrawl: ${fc.slice('__FIRECRAWL_ERROR__:'.length)})`
          : '';
        return {
          content: [{ type: 'text' as const, text: text + firecrawlNote }],
          details: undefined,
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `WebFetch failed: ${err?.message || 'Unknown error'}` }],
          details: undefined,
        };
      }
    },
  } as ToolDefinition;
}

export const webFetchTool: ToolDefinition = createWebFetchTool();

// ---------- WebSearch tool ----------

type SearchHit = { title: string; url: string; snippet: string; date?: string };

function formatSearchResults(query: string, web: SearchHit[], news: SearchHit[]): string {
  const lines: string[] = [`Search query: ${query}`];
  if (web.length === 0 && news.length === 0) {
    lines.push('No results found.');
    return lines.join('\n');
  }
  if (news.length > 0) {
    lines.push('', '## News');
    for (const r of news) {
      const date = r.date ? ` (${r.date})` : '';
      lines.push(`- ${r.title}${date}`);
      if (r.url) lines.push(`  ${r.url}`);
      if (r.snippet) lines.push(`  ${r.snippet}`);
    }
  }
  if (web.length > 0) {
    lines.push('', '## Web');
    for (const r of web) {
      lines.push(`- ${r.title}`);
      if (r.url) lines.push(`  ${r.url}`);
      if (r.snippet) lines.push(`  ${r.snippet}`);
    }
  }
  return truncate(lines.join('\n'));
}

export function createWebSearchTool(ctx?: PiWebToolContext): ToolDefinition {
  return {
    name: 'WebSearch',
    label: 'Web Search',
    description: 'Search the web (and news) via Firecrawl and return the top results.',
    promptSnippet: 'Search the web for recent or external information.',
    promptGuidelines: [
      'Use WebSearch when the answer depends on public web information.',
      'Keep the query focused and specific.',
      'For time-sensitive questions, mention the timeframe in the query.',
      'Follow up with WebFetch on the most promising result URLs for full text.',
    ],
    parameters: WebSearchParams,
    async execute(_toolCallId: string, params: { query: string }) {
      const query = params.query;

      const cached = cacheGet(searchCache, query);
      if (cached) {
        return { content: [{ type: 'text' as const, text: cached }], details: undefined };
      }

      const client = await resolveFirecrawl(ctx, 'pi_web_search');
      if (!client) {
        return {
          content: [{
            type: 'text' as const,
            text: 'WebSearch unavailable: FIRECRAWL_API_KEY is not configured on the server or granted to this project via Credential Vault.',
          }],
          details: undefined,
        };
      }

      try {
        const data = await withInflight(() =>
          client.search(query, {
            sources: ['web', 'news'],
            limit: 6,
          }),
        );

        const web: SearchHit[] = ((data as any).web ?? []).map((r: any) => ({
          title: r.title || r.url || '(untitled)',
          url: r.url || '',
          snippet: r.description || r.snippet || '',
        }));
        const news: SearchHit[] = ((data as any).news ?? []).map((r: any) => ({
          title: r.title || r.url || '(untitled)',
          url: r.url || '',
          snippet: r.snippet || r.description || '',
          date: r.date,
        }));

        const text = formatSearchResults(query, web, news);
        cacheSet(searchCache, query, text);
        return { content: [{ type: 'text' as const, text }], details: undefined };
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `WebSearch failed: ${err?.message || 'Unknown error'}`,
          }],
          details: undefined,
        };
      }
    },
  } as ToolDefinition;
}

export const webSearchTool: ToolDefinition = createWebSearchTool();

// Exported for tests.
export const __test__ = {
  clearCaches(): void {
    fetchCache.clear();
    searchCache.clear();
  },
  resetFirecrawl(): void {
    firecrawlSingleton = null;
    firecrawlInitFailed = false;
  },
};

