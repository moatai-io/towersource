import { describe, expect, it, vi } from 'vitest';
import { fetchLinearIssue } from './linear-client.js';

describe('fetchLinearIssue', () => {
  it('uses the personal API key without Bearer and maps a fresh issue snapshot', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBe('key');
      return new Response(JSON.stringify({ data: { issue: { id: 'i1', identifier: 'TOW-8', title: 'Title', description: null,
        url: 'https://linear.app/i', team: { key: 'TOW' }, project: { id: 'p1' }, assignee: null,
        labels: { nodes: [{ name: 'agent:research' }] } } } }), { status: 200 });
    }) as any;
    await expect(fetchLinearIssue('i1', 'key', fetcher)).resolves.toMatchObject({ identifier: 'TOW-8', teamKey: 'TOW', projectId: 'p1', labels: ['agent:research'] });
  });

  it('fails closed on HTTP 200 GraphQL errors', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { issue: null }, errors: [{ message: 'bad' }] }), { status: 200 })) as any;
    await expect(fetchLinearIssue('i1', 'key', fetcher)).rejects.toThrow('linear_graphql_error');
  });
});
