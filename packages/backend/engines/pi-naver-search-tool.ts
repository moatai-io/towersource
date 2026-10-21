// Owns: naver_search, a thin Gateway transport adapter for Naver Search.
// Search strategy and result interpretation remain in the naver-search skill.

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { resolveGatewayApiClient } from '../services/gateway-profile/gateway-profile-client.js';

const paramsSchema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 500, description: 'Korean or other search query.' }),
  type: Type.Optional(Type.Union([Type.Literal('news'), Type.Literal('blog')], { default: 'news' })),
  display: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 10 })),
  start: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 1 })),
  sort: Type.Optional(Type.Union([Type.Literal('sim'), Type.Literal('date')], { default: 'date' })),
}, { additionalProperties: false });

function stripMarkup(value: unknown): string {
  return String(value ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function boundedError(status: number, payload: any): string {
  const code = payload?.errorCode || payload?.error?.code || payload?.code || `gateway_http_${status}`;
  return `Naver Gateway search failed: HTTP ${status}, code=${code}`;
}

export function createNaverSearchTool(ctx: { projectId?: string; userId?: number }): ToolDefinition {
  return {
    name: 'naver_search',
    label: 'Naver Search',
    description: 'Search Naver news or blogs through the configured Tower Gateway. The tool uses the VM virtual key; it never requires Naver provider credentials in the Project.',
    promptSnippet: 'Use naver_search for Korean news and blog searches that specifically benefit from Naver results.',
    promptGuidelines: [
      'Use WebSearch for general global web search; use naver_search when Naver news or blog coverage is specifically relevant.',
      'Choose sort=date for recency and sort=sim for relevance.',
      'The tool only performs a bounded search call. Query strategy, filtering, comparison, and conclusions remain your responsibility.',
    ],
    parameters: paramsSchema,
    async execute(_toolCallId, rawParams, signal) {
      if (!ctx.projectId || !ctx.userId) {
        return { content: [{ type: 'text', text: '[naver_search error] Authenticated Project context is required.' }], isError: true } as any;
      }
      const params = rawParams as { query: string; type?: 'news' | 'blog'; display?: number; start?: number; sort?: 'sim' | 'date' };
      try {
        const gateway = await resolveGatewayApiClient({ actorUserId: ctx.userId, projectId: ctx.projectId, apiId: 'naver' });
        const type = params.type ?? 'news';
        const url = new URL(`${gateway.baseUrl}/search/${type}.json`);
        url.searchParams.set('query', params.query);
        url.searchParams.set('display', String(params.display ?? 10));
        url.searchParams.set('start', String(params.start ?? 1));
        url.searchParams.set('sort', params.sort ?? 'date');
        const response = await fetch(url, {
          method: 'GET',
          redirect: 'error',
          signal,
          headers: { Authorization: `Bearer ${gateway.apiKey}`, Accept: 'application/json' },
        });
        const payload = await response.json().catch(() => ({} as any));
        if (!response.ok) throw new Error(boundedError(response.status, payload));
        const items = Array.isArray(payload.items) ? payload.items.slice(0, params.display ?? 10).map((item: any) => ({
          title: stripMarkup(item.title),
          link: item.link,
          originalLink: item.originallink,
          description: stripMarkup(item.description),
          publishedAt: item.pubDate,
        })) : [];
        return {
          content: [{ type: 'text', text: JSON.stringify({ query: params.query, type, total: payload.total, start: payload.start, display: payload.display, items }, null, 2) }],
          details: { apiId: gateway.apiId, profileId: gateway.profileId, gateway: true, itemCount: items.length },
        };
      } catch (error) {
        const value = error as Error & { code?: string };
        return { content: [{ type: 'text', text: `[naver_search error] ${value.message}` }], details: { gateway: true, code: value.code ?? 'NAVER_SEARCH_FAILED' }, isError: true } as any;
      }
    },
  } as ToolDefinition;
}
