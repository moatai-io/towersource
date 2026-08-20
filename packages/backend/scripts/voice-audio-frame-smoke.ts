/** Verify that a synthetic LiveKit subscriber receives PCM frames from the voice agent greeting. */
import { randomUUID } from 'crypto';
import { AccessToken, AgentDispatchClient } from 'livekit-server-sdk';
import { AudioStream, Room, RoomEvent, TrackKind, type RemoteTrack } from '@livekit/rtc-node';
import { queryOne } from '../db/pg-repo.js';
import { resolveProjectApiKeySecretValue } from '../services/credential-vault/credential-vault-service.js';

async function main() {
  const projectId = process.argv[2];
  if (!projectId) throw new Error('project id required');
  const actor = await queryOne<{ user_id: number }>(`SELECT user_id FROM sessions WHERE project_id=$1 AND user_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1`, [projectId]);
  if (!actor) throw new Error('actor unavailable');
  const targetType = 'voice_audio_frame_smoke';
  const [url, key, secret] = await Promise.all(['LIVEKIT_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET'].map(envName => resolveProjectApiKeySecretValue({ projectId, userId: actor.user_id, envName, targetType })));
  if (!url || !key || !secret) throw new Error('connection unavailable');
  const roomName = `tower-voice-frame-smoke-${randomUUID()}`;
  const token = new AccessToken(key.value, secret.value, { identity: `smoke-${randomUUID()}`, ttl: 120 });
  token.addGrant({ roomJoin: true, room: roomName, canSubscribe: true, canPublish: false });
  const room = new Room();
  let frames = 0;
  let samples = 0;
  const diagnostics: string[] = [];
  const done = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`audio frame timeout frames=${frames} events=${diagnostics.join(',')}`)), 20_000);
    room.on(RoomEvent.TrackPublished, (publication, participant) => diagnostics.push(`published:${participant.identity}:${publication.sid}`));
    room.on(RoomEvent.TrackSubscriptionFailed, (sid, participant) => diagnostics.push(`failed:${sid}:${participant.identity}`));
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication, participant) => {
      diagnostics.push(`subscribed:${participant.identity}:${publication.sid}`);
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      void (async () => {
        const stream = new AudioStream(track, { sampleRate: 24_000, numChannels: 1 });
        for await (const frame of stream) {
          frames += 1;
          samples += frame.data.length;
          if (frames >= 5) {
            clearTimeout(timeout);
            resolve();
            break;
          }
        }
      })();
    });
  });
  await room.connect(url.value, await token.toJwt(), { autoSubscribe: true, dynacast: false });
  const subscribeTimer = setInterval(() => {
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) publication.setSubscribed(true);
    }
  }, 100);
  const host = url.value.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  await new AgentDispatchClient(host, key.value, secret.value).createDispatch(roomName, 'tower-korean-voice');
  await done;
  clearInterval(subscribeTimer);
  console.log(`agent_audio_pcm=pass frames=${frames} samples=${samples}`);
  await room.disconnect();
}
main().catch(error => { console.error(`agent_audio_pcm=fail reason=${error?.message || 'unknown'}`); process.exit(1); });
