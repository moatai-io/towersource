/**
 * Owns: immutable public request CTA parsing and conversation-scoped submission recording.
 * Public API: publicRequestActions, recordPublicCustomerRequest.
 */
import { createHash, randomUUID } from 'node:crypto';
import { queryOne } from '../../db/pg-repo.js';

export interface PublicRequestAction {
  id: string;
  label: string;
  description?: string;
  confirmationLabel: string;
  fields: Array<'name' | 'email' | 'phone'>;
}

interface RequestActionDefinition extends PublicRequestAction {
  destination: { type: 'email'; to: string };
  subjectPrefix: string;
}

function safeText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text.slice(0, max) : undefined;
}

function definitions(experienceSnapshot: unknown): RequestActionDefinition[] {
  const experience = experienceSnapshot && typeof experienceSnapshot === 'object' && !Array.isArray(experienceSnapshot)
    ? experienceSnapshot as Record<string, unknown> : {};
  if (!Array.isArray(experience.requestActions)) return [];
  return experience.requestActions.slice(0, 5).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const destination = row.destination && typeof row.destination === 'object' && !Array.isArray(row.destination)
      ? row.destination as Record<string, unknown> : {};
    const id = safeText(row.id, 64);
    const label = safeText(row.label, 60);
    const to = safeText(destination.to, 254);
    if (!id || !/^[a-z0-9][a-z0-9_-]*$/.test(id) || !label || destination.type !== 'email' || !to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return [];
    const fields = Array.isArray(row.fields) ? row.fields.filter((field): field is 'name' | 'email' | 'phone' => field === 'name' || field === 'email' || field === 'phone').slice(0, 3) : [];
    return [{
      id,
      label,
      description: safeText(row.description, 180),
      confirmationLabel: safeText(row.confirmationLabel, 80) || '이 내용으로 요청 보내기',
      fields,
      destination: { type: 'email' as const, to },
      subjectPrefix: safeText(row.subjectPrefix, 80) || label,
    }];
  });
}

/** Return only customer-readable CTA fields; destination addresses remain server-side. */
export function publicRequestActions(experienceSnapshot: unknown): PublicRequestAction[] {
  return definitions(experienceSnapshot).map(({ destination: _destination, subjectPrefix: _subjectPrefix, ...action }) => action);
}

export async function recordPublicCustomerRequest(input: {
  channelId: string;
  conversationId: string;
  tenantKey: string;
  userKey: string;
  actionId: string;
  subject?: string;
  body: string;
  contact?: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<{ id: string; status: string; message: string }> {
  const scope = await queryOne<{
    service_id: string; deployment_id: string; experience_snapshot: unknown; tenant_key: string; user_key: string;
  }>(`SELECT c.service_id,c.deployment_id,d.experience_snapshot,c.tenant_key,c.user_key
       FROM ai_service_conversations c
       JOIN ai_service_channels ch ON ch.id=c.channel_id AND ch.service_id=c.service_id AND ch.status='enabled'
       JOIN ai_service_deployments d ON d.id=c.deployment_id AND d.service_id=c.service_id AND d.status IN ('active','superseded')
      WHERE c.id=$1 AND c.channel_id=$2 AND c.status='open'`, [input.conversationId, input.channelId]);
  if (!scope || scope.tenant_key !== input.tenantKey || scope.user_key !== input.userKey) throw new Error('Customer request conversation is not accessible');
  const action = definitions(scope.experience_snapshot).find((candidate) => candidate.id === input.actionId);
  if (!action) throw new Error('Customer request action is not available');
  const body = safeText(input.body, 8_000);
  const idempotencyKey = safeText(input.idempotencyKey, 120);
  if (!body) throw new Error('Customer request body required');
  if (!idempotencyKey) throw new Error('Customer request idempotency key required');
  const contact = Object.fromEntries(action.fields.flatMap((field) => {
    const value = safeText(input.contact?.[field], 254);
    return value ? [[field, value]] : [];
  }));
  const subjectDetail = safeText(input.subject, 120);
  const subject = subjectDetail ? `[${action.subjectPrefix}] ${subjectDetail}` : `[${action.subjectPrefix}] 고객 요청`;
  const destinationRef = createHash('sha256').update(action.destination.to.toLowerCase()).digest('hex');
  const id = randomUUID();
  const row = await queryOne<{ id: string; status: string }>(`INSERT INTO ai_service_customer_requests
    (id,service_id,deployment_id,channel_id,conversation_id,action_id,action_label,destination_type,destination_ref,tenant_key,user_key,subject,body,contact,status,idempotency_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,'email',$8,$9,$10,$11,$12,$13::jsonb,'recorded',$14)
    ON CONFLICT(channel_id,conversation_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
    RETURNING id,status`, [id, scope.service_id, scope.deployment_id, input.channelId, input.conversationId, action.id, action.label, destinationRef, input.tenantKey, input.userKey, subject, body, JSON.stringify(contact), idempotencyKey]);
  if (!row) throw new Error('Customer request could not be recorded');
  return { id: row.id, status: row.status, message: '요청이 접수되었습니다. 메일 전달 상태는 담당자 설정에 따라 처리됩니다.' };
}
