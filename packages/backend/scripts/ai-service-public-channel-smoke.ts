/**
 * Smoke test for token-authenticated AI Service public Channel serving.
 *
 * Runs against the configured PostgreSQL database and Provider runtime.
 * It does not create a new Service; it requires an existing active Service with an enabled Channel.
 */
import { initPg, closePgPool } from '../db/pg.js';
import { query, queryOne } from '../db/pg-repo.js';
import { issueChannelCredential, verifyChannelCredential } from '../services/ai-service/channel-credential.js';
import { assertChannelCredentialNotRevoked, revokeChannelCredential } from '../services/ai-service/channel-credential-revocation.js';
import { assertChannelQuota } from '../services/ai-service/channel-quota.js';
import { createAIServiceChannelConversation, runAIServiceChannelTurn } from '../services/ai-service/ai-service-channel-runtime.js';
import { recordChannelUsageEvent } from '../services/ai-service/channel-usage.js';

interface CandidateRow {
  service_id: string;
  service_name: string;
  deployment_id: string;
  channel_id: string;
  channel_name: string;
  evaluation_count: string;
}

async function main() {
  await initPg();
  const iterations = Math.max(1, Math.min(20, Number.parseInt(process.env.AI_SERVICE_SMOKE_ITERATIONS || '1', 10) || 1));

  const candidates = await query<CandidateRow>(
    `SELECT s.id AS service_id, s.name AS service_name, s.current_deployment_id AS deployment_id,
            c.id AS channel_id, c.name AS channel_name,
            (SELECT COUNT(*) FROM ai_service_runtime_evaluations e WHERE e.deployment_id=s.current_deployment_id) AS evaluation_count
       FROM ai_services s
       JOIN ai_service_channels c ON c.service_id=s.id
       JOIN ai_service_deployments d ON d.id=s.current_deployment_id AND d.service_id=s.id
      WHERE s.status='active'
        AND d.status='active'
        AND c.status='enabled'
        AND c.active_deployment_id=s.current_deployment_id
        AND EXISTS (SELECT 1 FROM ai_service_runtime_evaluations e WHERE e.deployment_id=s.current_deployment_id AND e.status='passed')
      ORDER BY s.updated_at DESC
      LIMIT 3`,
  );

  const candidate = candidates[0];
  if (!candidate) {
    console.log(JSON.stringify({ ok: false, skipped: true, reason: 'no active AI Service with enabled Channel and passed evaluation found' }, null, 2));
    return;
  }

  const before = await queryOne<{ count: string }>('SELECT COUNT(*) AS count FROM ai_service_runtime_evaluations WHERE deployment_id=$1', [candidate.deployment_id]);
  const runs = [] as Array<{ iteration: number; conversationId: string; responses: Array<{ textLength: number; toolCount: number }> }>;
  let totalUsageEvents = 0;
  let lastRevokedTokenHash = '';

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
  const tenantKey = `smoke:${Date.now()}:${iteration}`;
  const userKey = 'public-channel-smoke';
  const issued = issueChannelCredential({
    serviceId: candidate.service_id,
    channelId: candidate.channel_id,
    tenantKey,
    userKey,
    exposure: 'auth-required',
    ttlSeconds: 900,
  });
  const claims = verifyChannelCredential(issued.token, { serviceId: candidate.service_id, channelId: candidate.channel_id });
  await assertChannelCredentialNotRevoked(issued.token);
  await recordChannelUsageEvent({ serviceId: claims.serviceId, channelId: claims.channelId, tenantKey: claims.tenantKey, userKey: claims.userKey, eventType: 'credential_issued', exposure: claims.exposure, metadata: { smoke: true, expiresAt: issued.expiresAt } });

  const conversation = await createAIServiceChannelConversation({
    serviceId: claims.serviceId,
    channelId: claims.channelId,
    tenantKey: claims.tenantKey,
    userKey: claims.userKey,
  });
  await recordChannelUsageEvent({ serviceId: claims.serviceId, channelId: claims.channelId, conversationId: conversation.id, tenantKey: claims.tenantKey, userKey: claims.userKey, eventType: 'conversation_created', exposure: claims.exposure, metadata: { smoke: true } });

  const prompts = [
    'Smoke test: reply with one short Korean sentence confirming this deployed channel can answer.',
    'Smoke test follow-up: answer in one short Korean sentence and do not ask questions.',
  ];
  const responses = [] as Array<{ textLength: number; toolCount: number }>;
  for (const prompt of prompts) {
    await assertChannelCredentialNotRevoked(issued.token);
    await assertChannelQuota({ serviceId: claims.serviceId, channelId: claims.channelId, tenantKey: claims.tenantKey });
    const response = await runAIServiceChannelTurn({
      serviceId: claims.serviceId,
      channelId: claims.channelId,
      conversationId: conversation.id,
      tenantKey: claims.tenantKey,
      userKey: claims.userKey,
      prompt,
      userRole: 'ai_service_channel_smoke',
    });
    await recordChannelUsageEvent({ serviceId: claims.serviceId, channelId: claims.channelId, conversationId: conversation.id, tenantKey: claims.tenantKey, userKey: claims.userKey, eventType: 'message_turn', exposure: claims.exposure, metadata: { smoke: true, textLength: response.text.length, toolCount: response.provenance.toolCount } });
    responses.push({ textLength: response.text.length, toolCount: response.provenance.toolCount });
  }

  const usage = await queryOne<{ count: string }>(
    'SELECT COUNT(*) AS count FROM ai_service_channel_usage_events WHERE service_id=$1 AND channel_id=$2 AND tenant_key=$3',
    [claims.serviceId, claims.channelId, claims.tenantKey],
  );
  totalUsageEvents += Number(usage?.count || 0);

  const revoked = await revokeChannelCredential({ token: issued.token, claims, reason: 'smoke-complete' });
  let revocationBlocked = false;
  try {
    await assertChannelCredentialNotRevoked(issued.token);
  } catch {
    revocationBlocked = true;
  }
  if (!revocationBlocked) throw new Error('revoked Channel credential was not blocked');
  lastRevokedTokenHash = revoked.tokenHash;
  runs.push({ iteration, conversationId: conversation.id, responses });
  }

  const after = await queryOne<{ count: string }>('SELECT COUNT(*) AS count FROM ai_service_runtime_evaluations WHERE deployment_id=$1', [candidate.deployment_id]);
  const beforeCount = Number(before?.count || 0);
  const afterCount = Number(after?.count || 0);
  if (beforeCount !== afterCount) {
    throw new Error(`runtime evaluation count changed during Channel smoke: before=${beforeCount}, after=${afterCount}`);
  }

  console.log(JSON.stringify({
    ok: true,
    iterations,
    serviceId: candidate.service_id,
    serviceName: candidate.service_name,
    channelId: candidate.channel_id,
    channelName: candidate.channel_name,
    evaluationCountBefore: beforeCount,
    evaluationCountAfter: afterCount,
    usageEvents: totalUsageEvents,
    revokedTokenHash: lastRevokedTokenHash,
    revocationBlocked: true,
    runs,
  }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2));
  process.exitCode = 1;
}).finally(async () => {
  await closePgPool().catch(() => {});
});
