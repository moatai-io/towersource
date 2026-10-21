import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createLinearWebhookResolver, createLinearWebhookVerifier } from './adapter.js';
function request(headers: Record<string, string>) { return { get: (name: string) => headers[name.toLowerCase()] } as any; }
const policy = { allowedTeamKeys: ['TOW'], allowedLinearProjectIds: ['lp1'],
  routeLabels: { research: 'agent:research', draft: 'agent:draft', implement: 'agent:implement' } as const,
  approvalLabel: 'approval-required' };
function signed(payload: object, secret = 'secret') { const rawBody = Buffer.from(JSON.stringify(payload));
  return { rawBody, req: request({ 'linear-signature': createHmac('sha256', secret).update(rawBody).digest('hex'), 'linear-delivery': 'd1' }) }; }

describe('Linear Webhook adapter', () => {
  it('verifies and normalizes with only the signing secret', () => {
    const verifier = createLinearWebhookVerifier('secret');
    const { rawBody, req } = signed({ action: 'update', type: 'Issue', webhookTimestamp: 1_000_000, data: { id: 'i1' } });
    expect(verifier.verify({ request: req, rawBody, now: 1_000_100 })).toMatchObject({ ok: true,
      event: { provider: 'linear', deliveryId: 'd1', resourceId: 'i1' } });
  });
  it('rejects invalid signatures and stale replay', () => {
    const verifier = createLinearWebhookVerifier('secret');
    const value = signed({ action: 'update', type: 'Issue', webhookTimestamp: 1_000_000, data: { id: 'i1' } });
    expect(verifier.verify({ request: request({ 'linear-signature': '0'.repeat(64), 'linear-delivery': 'd1' }), rawBody: value.rawBody, now: 1_000_100 })).toMatchObject({ ok: false, status: 401 });
    expect(verifier.verify({ request: value.req, rawBody: value.rawBody, now: 1_060_001 })).toMatchObject({ ok: false, error: 'linear_webhook_stale' });
  });
  it('keeps Provider API access in the internal resolver', async () => {
    const resolver = createLinearWebhookResolver({ apiKey: 'key', policy });
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: 'bad' }] }), { status: 200 })) as any;
    try { await expect(resolver.resolve({ provider: 'linear', deliveryId: 'd1', eventType: 'Issue', action: 'update', occurredAt: 1, resourceId: 'i1' }))
      .rejects.toThrow('linear_graphql_error'); }
    finally { globalThis.fetch = original; }
  });
  it('ignores events whose canonical issue is unavailable to the Dispatcher credential', async () => {
    const resolver = createLinearWebhookResolver({ apiKey: 'key', policy });
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: 'Entity not found: Issue', extensions: { code: 'INPUT_ERROR' } }] }), { status: 200 })) as any;
    try { await expect(resolver.resolve({ provider: 'linear', deliveryId: 'd1', eventType: 'Issue', action: 'update', occurredAt: 1, resourceId: 'private' }))
      .resolves.toEqual({ kind: 'ignore', reason: 'provider_resource_unavailable' }); }
    finally { globalThis.fetch = original; }
  });
});
