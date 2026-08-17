/**
 * Owns: Narrow callback contract between LiveKit voice jobs and Tower's durable Agent turn path.
 * Public API: createTowerVoiceDelegate. See README.md.
 */

import type { TowerVoiceDelegate } from './livekit-inference-worker.js';

export interface TowerVoiceTurnGateway {
  run(input: {
    sessionId: string;
    message: string;
    metadata: { sourceType: 'voice'; responseMode: 'spoken-korean' };
    signal?: AbortSignal;
  }): Promise<{ assistantText: string }>;
}

/** Adapt the future shared Session-turn gateway without importing ws-handler internals. */
export function createTowerVoiceDelegate(gateway: TowerVoiceTurnGateway): TowerVoiceDelegate {
  return {
    async runTurn({ towerSessionId, transcript, signal }) {
      const result = await gateway.run({
        sessionId: towerSessionId,
        message: transcript,
        metadata: { sourceType: 'voice', responseMode: 'spoken-korean' },
        signal,
      });
      return result.assistantText;
    },
  };
}
