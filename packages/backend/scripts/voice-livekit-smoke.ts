import { AgentDispatchClient } from 'livekit-server-sdk';
import { queryOne } from '../db/pg-repo.js';
import { resolveProjectApiKeySecretValue } from '../services/credential-vault/credential-vault-service.js';
import { createLiveKitAccessFactory } from '../services/voice-runtime/livekit-access.js';

async function main() {
  const projectId = process.argv[2];
  if (!projectId) throw new Error('project id required');
  const actor = await queryOne<{ user_id: number }>(
    `SELECT COALESCE(s.user_id, 1)::int AS user_id FROM sessions s WHERE s.project_id=$1 AND s.user_id IS NOT NULL ORDER BY s.updated_at DESC LIMIT 1`, [projectId],
  );
  if (!actor?.user_id) throw new Error('project actor unavailable');
  const targetType = 'voice_livekit_smoke';
  const [url, key, secret] = await Promise.all([
    resolveProjectApiKeySecretValue({ projectId, userId: actor.user_id, envName: 'LIVEKIT_URL', targetType }),
    resolveProjectApiKeySecretValue({ projectId, userId: actor.user_id, envName: 'LIVEKIT_API_KEY', targetType }),
    resolveProjectApiKeySecretValue({ projectId, userId: actor.user_id, envName: 'LIVEKIT_API_SECRET', targetType }),
  ]);
  console.log(`vault=${url && key && secret ? 'pass' : 'fail'}`);
  if (!url || !key || !secret) process.exit(2);
  const makeAccess = createLiveKitAccessFactory({
    url: url.value,
    apiKey: key.value,
    apiSecret: secret.value,
    agentName: process.argv.includes('--dispatch') ? 'tower-korean-voice' : undefined,
  });
  const access = await makeAccess({ roomName: 'tower-voice-smoke', userIdentity: 'smoke-user' });
  console.log(`token=${access.token.length > 100 && access.url.startsWith('wss://') ? 'pass' : 'fail'}`);
  const host = access.url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  const client = new AgentDispatchClient(host, key.value, secret.value, { requestTimeout: 8_000 });
  try {
    await client.listDispatch('tower-voice-smoke');
    console.log('provider_auth=pass');
  } catch (error: any) {
    if (String(error?.message || '').toLowerCase().includes('room does not exist')) {
      console.log('provider_auth=pass (authenticated room lookup)');
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(`${error?.name ?? 'Error'}: ${error?.message ?? 'smoke failed'}`);
  process.exit(1);
});
