/** Start Tower's self-hosted LiveKit Korean voice worker with Project Vault credentials. */
import { AgentServer, ServerOptions, initializeLogger } from '@livekit/agents';
import { queryOne } from '../db/pg-repo.js';
import { resolveProjectApiKeySecretValue } from '../services/credential-vault/credential-vault-service.js';

const AGENT_NAME = 'tower-korean-voice';

async function main() {
  const projectId = process.argv[2] || process.env.TOWER_VOICE_PROJECT_ID;
  if (!projectId) throw new Error('Project id required');
  const actor = await queryOne<{ user_id: number }>(
    `SELECT COALESCE(s.user_id, 1)::int AS user_id FROM sessions s WHERE s.project_id=$1 AND s.user_id IS NOT NULL ORDER BY s.updated_at DESC LIMIT 1`,
    [projectId],
  );
  if (!actor?.user_id) throw new Error('Project actor unavailable');
  const targetType = 'voice_livekit_worker';
  const [url, key, secret] = await Promise.all([
    resolveProjectApiKeySecretValue({ projectId, userId: actor.user_id, envName: 'LIVEKIT_URL', targetType }),
    resolveProjectApiKeySecretValue({ projectId, userId: actor.user_id, envName: 'LIVEKIT_API_KEY', targetType }),
    resolveProjectApiKeySecretValue({ projectId, userId: actor.user_id, envName: 'LIVEKIT_API_SECRET', targetType }),
  ]);
  if (!url || !key || !secret) throw new Error('LiveKit Project Connection unavailable');

  // Agent jobs run in child processes; inference adapters read these standard names there.
  process.env.LIVEKIT_URL = url.value;
  process.env.LIVEKIT_API_KEY = key.value;
  process.env.LIVEKIT_API_SECRET = secret.value;
  initializeLogger({ pretty: true, level: 'info' });
  const server = new AgentServer(new ServerOptions({
    agent: new URL('../services/voice-runtime/livekit-agent-entry.ts', import.meta.url).pathname,
    agentName: AGENT_NAME,
    wsURL: url.value,
    apiKey: key.value,
    apiSecret: secret.value,
    production: false,
    logLevel: 'info',
  }));
  const shutdown = async () => { await server.drain(10_000); await server.close(); };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  console.log(`voice_worker=starting agent=${AGENT_NAME}`);
  await server.run();
}

main().catch((error) => {
  console.error(`voice_worker=failed reason=${error?.name ?? 'Error'}:${error?.message ?? 'unknown'}`);
  process.exit(1);
});
