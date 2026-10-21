import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { WebhookResolver, WebhookRoute, WebhookVerifier } from '../../contract.js';
import { fetchLinearIssue, LinearIssueUnavailableError } from './linear-client.js';

const payloadSchema = z.object({ action: z.string().min(1).max(80), type: z.string().min(1).max(80),
  webhookTimestamp: z.number().int().positive(), data: z.object({ id: z.string().min(1).max(100) }).passthrough() }).passthrough();

export interface LinearWebhookPolicy {
  allowedTeamKeys: string[];
  allowedLinearProjectIds: string[];
  routeLabels: Record<WebhookRoute, string>;
  approvalLabel: string;
}

function signatureValid(rawBody: Buffer, supplied: string | undefined, secret: string): boolean {
  if (!secret || !supplied || !/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const actual = Buffer.from(supplied, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function prompt(issue: Awaited<ReturnType<typeof fetchLinearIssue>>, route: WebhookRoute): string {
  const boundary = route === 'implement' ? '현재 Tower Project 내부의 로컬 구현과 비파괴 검증까지만 수행하세요.'
    : route === 'draft' ? '초안과 검토 가능한 산출물만 만들고 외부 발송이나 상태 변경은 하지 마세요.'
      : '조사와 근거 정리만 수행하고 외부 시스템을 변경하지 마세요.';
  return [`Linear 이슈 ${issue.identifier}: ${issue.title}`, issue.url, '', issue.description || '(설명 없음)', '',
    `작업 유형: ${route}`, boundary,
    '배포, 삭제, 구매, 외부 발송, 운영 설정 변경은 실행하지 말고 필요한 승인 사항으로 보고하세요.',
    '완료 시 수행 내용, 검증 결과, 남은 승인 사항을 명확히 요약하세요.'].join('\n');
}

export function createLinearWebhookVerifier(secret: string): WebhookVerifier {
  return { provider: 'linear', verify({ request, rawBody, now = Date.now() }) {
    if (!signatureValid(rawBody, request.get('linear-signature'), secret)) return { ok: false, status: 401, error: 'linear_webhook_unauthorized' };
    let payload: z.infer<typeof payloadSchema>;
    try { payload = payloadSchema.parse(JSON.parse(rawBody.toString('utf8'))); }
    catch { return { ok: false, status: 400, error: 'linear_webhook_invalid_payload' }; }
    if (Math.abs(now - payload.webhookTimestamp) > 60_000) return { ok: false, status: 401, error: 'linear_webhook_stale' };
    const deliveryId = request.get('linear-delivery');
    if (!deliveryId || deliveryId.length > 100) return { ok: false, status: 400, error: 'linear_webhook_delivery_missing' };
    return { ok: true, event: { provider: 'linear', deliveryId, eventType: payload.type, action: payload.action,
      occurredAt: payload.webhookTimestamp, resourceId: payload.data.id } };
  } };
}

export function createLinearWebhookResolver(input: { apiKey: string; policy: LinearWebhookPolicy }): WebhookResolver {
  return { provider: 'linear', async resolve(event) {
    if (event.eventType !== 'Issue' || !['create', 'update'].includes(event.action)) return { kind: 'ignore', reason: 'event_not_supported' };
    let issue: Awaited<ReturnType<typeof fetchLinearIssue>>;
    try { issue = await fetchLinearIssue(event.resourceId, input.apiKey); }
    catch (error) {
      if (error instanceof LinearIssueUnavailableError) return { kind: 'ignore', reason: 'provider_resource_unavailable' };
      throw error;
    }
    if (!input.policy.allowedTeamKeys.includes(issue.teamKey)) return { kind: 'ignore', reason: 'team_not_allowed', resourceKey: issue.identifier };
    if (!issue.projectId || !input.policy.allowedLinearProjectIds.includes(issue.projectId)) return { kind: 'ignore', reason: 'provider_project_not_allowed', resourceKey: issue.identifier };
    if (issue.labels.includes(input.policy.approvalLabel)) return { kind: 'ignore', reason: 'approval_required', resourceKey: issue.identifier };
    const routes = (Object.entries(input.policy.routeLabels) as Array<[WebhookRoute, string]>)
      .filter(([, label]) => issue.labels.includes(label)).map(([route]) => route);
    if (routes.length === 0) return { kind: 'ignore', reason: 'route_label_missing', resourceKey: issue.identifier };
    if (routes.length > 1) return { kind: 'ignore', reason: 'route_label_ambiguous', resourceKey: issue.identifier };
    return { kind: 'run', route: routes[0], title: `[Linear ${issue.identifier}] ${issue.title}`,
      prompt: prompt(issue, routes[0]), resourceKey: issue.identifier };
  } };
}
