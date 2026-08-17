/**
 * Owns: Authenticated HTTP boundary for ephemeral voice sessions.
 * Public API: createVoiceRouter. See README.md.
 */

import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../auth/auth.js';
import { canAccessSession } from '../pm/project-access.js';
import { getSession } from '../session/session-manager.js';
import { VoiceSessionManager } from './voice-session-manager.js';
import { createVoiceTurnToken, verifyVoiceTurnToken } from './voice-turn-token.js';
import { runTowerVoiceTurn } from './tower-session-turn-gateway.js';

const StartVoiceSchema = z.object({
  ttsProvider: z.enum(['typecast', 'elevenlabs']).optional(),
  inferenceTtsProvider: z.enum(['cartesia', 'inworld']).default('cartesia'),
  maxSpokenSeconds: z.number().int().min(5).max(30).optional(),
}).strict();

const StopVoiceSchema = z.object({ voiceSessionId: z.string().uuid() }).strict();
const VoiceTurnSchema = z.object({ token: z.string().min(32), transcript: z.string().trim().min(1).max(20_000) }).strict();

export interface VoiceRouterDependencies {
  manager?: VoiceSessionManager;
  createLiveKitAccess?: (input: { roomName: string; userIdentity: string; projectId: string; userId: number; dispatchMetadata?: string }) => Promise<{ url: string; token: string } | null>;
}

/** Create the voice API router; mount it after Tower auth middleware. */
export function createVoiceRouter(deps: VoiceRouterDependencies = {}): Router {
  const router = Router();
  const manager = deps.manager ?? new VoiceSessionManager();

  // This router is mounted at the broad /api boundary, so auth must only
  // intercept voice routes and let /health and every unrelated API continue.
  router.use('/sessions/:sessionId/voice', authMiddleware);

  router.post('/sessions/:sessionId/voice/start', async (req, res) => {
    const userId = Number((req as any).user?.userId);
    const role = String((req as any).user?.role || 'guest');
    if (!Number.isInteger(userId) || userId <= 0) return res.status(401).json({ error: 'Authentication required' });

    const parsed = StartVoiceSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid voice settings', details: parsed.error.flatten() });

    const access = await canAccessSession(req.params.sessionId, userId, role);
    if (!access.allowed) return res.status(access.status).json({ error: access.message });

    const session = await getSession(req.params.sessionId);
    if (!session?.projectId) return res.status(409).json({ error: 'Voice requires a Project-backed Tower Session' });

    const voiceSession = manager.start(req.params.sessionId, userId, parsed.data);
    const turnToken = createVoiceTurnToken({
      sessionId: req.params.sessionId,
      voiceSessionId: voiceSession.id,
      userId,
      expiresAt: Date.parse(voiceSession.expiresAt),
    });
    const livekit = deps.createLiveKitAccess
      ? await deps.createLiveKitAccess({
        roomName: `tower-voice-${voiceSession.id}`,
        userIdentity: `user-${userId}`,
        projectId: session.projectId,
        userId,
        dispatchMetadata: JSON.stringify({
          towerSessionId: req.params.sessionId,
          turnToken,
          inferenceTtsProvider: parsed.data.inferenceTtsProvider,
        }),
      })
      : null;
    if (!livekit) {
      manager.stop(voiceSession.id, userId);
      return res.status(503).json({ error: 'LiveKit Connection is not available for this Project' });
    }
    return res.status(201).json({ voiceSession, livekit, ready: true });
  });

  router.post('/voice/internal/turn', async (req, res) => {
    const parsed = VoiceTurnSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid voice turn' });
    const claims = verifyVoiceTurnToken(parsed.data.token);
    if (!claims) return res.status(401).json({ error: 'Voice turn token expired or invalid' });
    const voiceSession = manager.get(claims.voiceSessionId);
    if (!voiceSession
      || voiceSession.towerSessionId !== claims.sessionId
      || voiceSession.userId !== claims.userId) {
      return res.status(410).json({ error: 'Voice session is no longer active' });
    }
    try {
      const assistantText = await runTowerVoiceTurn({
        sessionId: claims.sessionId,
        userId: claims.userId,
        transcript: parsed.data.transcript,
      });
      return res.json({ assistantText });
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || 'Tower voice turn failed' });
    }
  });

  router.get('/sessions/:sessionId/voice/:voiceSessionId', async (req, res) => {
    const userId = Number((req as any).user?.userId);
    const role = String((req as any).user?.role || 'guest');
    if (!Number.isInteger(userId) || userId <= 0) return res.status(401).json({ error: 'Authentication required' });
    const access = await canAccessSession(req.params.sessionId, userId, role);
    if (!access.allowed) return res.status(access.status).json({ error: access.message });
    const voiceSession = manager.get(req.params.voiceSessionId);
    if (!voiceSession || voiceSession.towerSessionId !== req.params.sessionId || voiceSession.userId !== userId) {
      return res.status(404).json({ error: 'Voice session not found' });
    }
    return res.json({ voiceSession });
  });

  router.post('/sessions/:sessionId/voice/stop', async (req, res) => {
    const userId = Number((req as any).user?.userId);
    const role = String((req as any).user?.role || 'guest');
    if (!Number.isInteger(userId) || userId <= 0) return res.status(401).json({ error: 'Authentication required' });
    const parsed = StopVoiceSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid voice session id' });
    const access = await canAccessSession(req.params.sessionId, userId, role);
    if (!access.allowed) return res.status(access.status).json({ error: access.message });
    const current = manager.get(parsed.data.voiceSessionId);
    if (!current || current.towerSessionId !== req.params.sessionId) return res.status(404).json({ error: 'Voice session not found' });
    if (!manager.stop(parsed.data.voiceSessionId, userId)) return res.status(404).json({ error: 'Voice session not found' });
    return res.status(204).send();
  });

  return router;
}
