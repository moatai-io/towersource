/** Inspect current LiveKit rooms without printing credentials or tokens. */
import { RoomServiceClient } from 'livekit-server-sdk';
import { queryOne } from '../db/pg-repo.js';
import { resolveProjectApiKeySecretValue } from '../services/credential-vault/credential-vault-service.js';

async function main() {
  const projectId = process.argv[2];
  if (!projectId) throw new Error('project id required');
  const actor = await queryOne<{ user_id: number }>(`SELECT user_id FROM sessions WHERE project_id=$1 AND user_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1`, [projectId]);
  if (!actor) throw new Error('actor unavailable');
  const targetType = 'voice_live_room_inspect';
  const [url, key, secret] = await Promise.all(['LIVEKIT_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET'].map(envName => resolveProjectApiKeySecretValue({ projectId, userId: actor.user_id, envName, targetType })));
  if (!url || !key || !secret) throw new Error('connection unavailable');
  const host = url.value.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  const client = new RoomServiceClient(host, key.value, secret.value);
  const rooms = (await client.listRooms()).filter(room => room.name.startsWith('tower-voice-'));
  for (const room of rooms) {
    const participants = await client.listParticipants(room.name);
    console.log(JSON.stringify({ room: room.name, participants: participants.map(p => ({ identity: p.identity, kind: p.kind, state: p.state, tracks: p.tracks.map(t => ({ sid: t.sid, type: t.type, source: t.source, muted: t.muted })) })) }, null, 2));
  }
}
main().catch(error => { console.error(error?.message || error); process.exit(1); });
