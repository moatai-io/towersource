/** Owns: Mount point for authenticated Korean voice runtime HTTP routes. */
import { createVoiceRouter } from '../services/voice-runtime/voice-router.js';
import { buildLiveKitAccessFromEnv, buildLiveKitAccessFromProjectVault } from '../services/voice-runtime/voice-runtime-env.js';

const processFactory = buildLiveKitAccessFromEnv();

export default createVoiceRouter({
  async createLiveKitAccess(input) {
    const factory = processFactory ?? await buildLiveKitAccessFromProjectVault({
      projectId: input.projectId,
      userId: input.userId,
    });
    return factory?.({
      roomName: input.roomName,
      userIdentity: input.userIdentity,
      dispatchMetadata: input.dispatchMetadata,
    }) ?? null;
  },
});
