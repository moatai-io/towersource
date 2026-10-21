import { createHash } from 'node:crypto';
import type { Request } from 'express';

export type WebhookEventStatus = 'queued' | 'dispatching' | 'ignored' | 'task_created' | 'failed' | 'needs_review';
export type WebhookRoute = 'research' | 'draft' | 'implement';

export interface CanonicalWebhookEvent {
  provider: string;
  deliveryId: string;
  eventType: string;
  action: string;
  occurredAt: number;
  resourceId: string;
}

export interface WebhookRouteDecision {
  kind: 'run';
  route: WebhookRoute;
  title: string;
  prompt: string;
  resourceKey?: string;
}

export interface WebhookIgnoreDecision {
  kind: 'ignore';
  reason: string;
  resourceKey?: string;
}

/** Public-ingress capability: signing secret only, no Provider read credential or Tower authority. */
export interface WebhookVerifier {
  provider: string;
  verify(input: { request: Request; rawBody: Buffer; now?: number }):
    | { ok: true; event: CanonicalWebhookEvent }
    | { ok: false; status: number; error: string };
}

/** Internal-dispatch capability: Provider read + routing, never exposed as an HTTP verifier. */
export interface WebhookResolver {
  provider: string;
  resolve(event: CanonicalWebhookEvent): Promise<WebhookRouteDecision | WebhookIgnoreDecision>;
}

export interface WebhookIngressBinding {
  connectorId: string;
  verifier: WebhookVerifier;
}

export interface WebhookDispatchBinding {
  connectorId: string;
  projectId: string;
  runAsUserId: number;
  resolver: WebhookResolver;
}

export function webhookPayloadHash(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}
