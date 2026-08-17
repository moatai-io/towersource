/**
 * Owns: Least-privilege LiveKit room tokens for Tower voice participants.
 * Public API: createLiveKitAccessFactory. See README.md.
 */

import { AccessToken, AgentDispatchClient, TrackSource } from 'livekit-server-sdk';

export interface LiveKitAccessOptions {
  url: string;
  apiKey: string;
  apiSecret: string;
  ttlSeconds?: number;
  agentName?: string;
}

/** Build short-lived microphone-only participant access without exposing the LiveKit secret. */
export function createLiveKitAccessFactory(options: LiveKitAccessOptions) {
  return async ({ roomName, userIdentity, dispatchMetadata }: { roomName: string; userIdentity: string; dispatchMetadata?: string }) => {
    const token = new AccessToken(options.apiKey, options.apiSecret, {
      identity: userIdentity,
      ttl: options.ttlSeconds ?? 5 * 60,
    });
    if (options.agentName) {
      const host = options.url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
      const dispatch = new AgentDispatchClient(host, options.apiKey, options.apiSecret);
      await dispatch.createDispatch(roomName, options.agentName, { metadata: dispatchMetadata });
    }
    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE],
      canSubscribe: true,
      canPublishData: false,
    });
    return { url: options.url, token: await token.toJwt() };
  };
}
