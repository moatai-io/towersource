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
import { closeTowerVoiceSession, requestVoiceTurnCancellation, runTowerVoiceTurn, VoiceTurnError } from './tower-session-turn-gateway.js';
import { queryOne } from '../../db/pg-repo.js';

const StartVoiceSchema = z.object({
  ttsProvider: z.enum(['typecast', 'elevenlabs']).optional(),
  inferenceTtsProvider: z.enum(['cartesia', 'inworld']).default('cartesia'),
  maxSpokenSeconds: z.number().int().min(5).max(30).optional(),
}).strict();

const StopVoiceSchema = z.object({ voiceSessionId: z.string().uuid() }).strict();
const VoiceIdentitySchema = z.object({
  token: z.string().min(32), turnId: z.string().uuid(), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
const VoiceTurnSchema = VoiceIdentitySchema.extend({ transcript: z.string().trim().min(1).max(20_000) });

export interface VoiceRouterDependencies {
  manager?: VoiceSessionManager;
  enabled?: boolean;
  createLiveKitAccess?: (input: { roomName: string; userIdentity: string; projectId: string; userId: number; dispatchMetadata?: string }) => Promise<{ url: string; token: string } | null>;
}

export function isVoiceRuntimeEnabled(value = process.env.TOWER_VOICE_ENABLED): boolean {
  return value === 'true';
}

/** Create the voice API router; mount it after Tower auth middleware. */
export function createVoiceRouter(deps: VoiceRouterDependencies = {}): Router {
  const router = Router();
  const manager = deps.manager ?? new VoiceSessionManager();
  const enabled = deps.enabled ?? isVoiceRuntimeEnabled();

  const requireVoiceEnabled = (_req: any, res: any, next: any) => {
    if (enabled) return next();
    return res.status(503).json({ error: 'Voice is disabled' });
  };

  // This router is mounted at the broad /api boundary, so feature gating and
  // auth must only intercept voice routes and let every unrelated API continue.
  router.use('/sessions/:sessionId/voice', requireVoiceEnabled, authMiddleware);
  router.use('/voice/internal', requireVoiceEnabled);

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

  for (const operation of ['turn', 'cancel'] as const) {
    router.post(`/voice/internal/${operation}`, async (req, res) => {
      const parsed = (operation === 'turn' ? VoiceTurnSchema : VoiceIdentitySchema).safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: 'Invalid voice turn identity or input' });
      const claims = verifyVoiceTurnToken(parsed.data.token);
      if (!claims) return res.status(401).json({ error: 'Voice turn token expired or invalid' });
      const voiceSession = manager.get(claims.voiceSessionId);
      if (!voiceSession || voiceSession.towerSessionId !== claims.sessionId || voiceSession.userId !== claims.userId) {
        return res.status(410).json({ error: 'Voice session is no longer active' });
      }
      let streaming = false;
      let streamFailed = false;
      try {
        // A capability is not a permanent authorization grant: re-check current account and ACL.
        const actor = await queryOne<{ role: string }>('SELECT role FROM users WHERE id = $1', [claims.userId]);
        if (!actor) return res.status(403).json({ error: 'Voice user no longer exists' });
        const access = await canAccessSession(claims.sessionId, claims.userId, actor.role);
        if (!access.allowed) return res.status(access.status).json({ error: access.message });
        // stop/expiry may have raced the asynchronous current-authority checks.
        if (!manager.get(claims.voiceSessionId)) return res.status(410).json({ error: 'Voice session is no longer active' });
        const identity = {
          sessionId: claims.sessionId, voiceSessionId: claims.voiceSessionId, userId: claims.userId,
          turnId: parsed.data.turnId, revision: parsed.data.revision,
        };
        if (operation === 'cancel') {
          const accepted = await requestVoiceTurnCancellation(identity);
          // accepted refers to cancellation admission/safe-stop, not rollback or engine terminal completion.
          return res.json({ accepted, turnId: identity.turnId, revision: identity.revision });
        }
        const wantsStream = String(req.headers?.accept || '').split(',').some((value) => value.trim().split(';')[0] === 'application/x-ndjson');
        const disconnect = () => {
          if (!res.writableEnded) void requestVoiceTurnCancellation(identity).catch(() => false);
        };
        if (wantsStream) res.once('close', disconnect);
        try {
          const assistantText = await runTowerVoiceTurn({
            ...identity, transcript: (parsed.data as z.infer<typeof VoiceTurnSchema>).transcript,
            expiresAt: claims.expiresAt,
          }, wantsStream ? (event) => {
            if (res.destroyed || streamFailed) return;
            if (!streaming) {
              streaming = true;
              res.status(200);
              res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
              res.setHeader('Cache-Control', 'no-store');
              res.setHeader('X-Accel-Buffering', 'no');
              res.flushHeaders();
            }
            if (!res.write(`${JSON.stringify(event)}\n`)) {
              // Bound per-client queued bytes; do not slow the durable engine or retain an unbounded replay socket.
              if (res.writableLength > 256_000) {
                streamFailed = true;
                void requestVoiceTurnCancellation(identity).catch(() => false);
                res.destroy();
              }
            }
          } : undefined);
          if (wantsStream) return res.end();
          return res.json({ assistantText, turnId: identity.turnId, revision: identity.revision });
        } finally {
          if (wantsStream) res.off('close', disconnect);
        }
      } catch (error) {
        if (streaming) {
          // Gateway already emitted the correlated terminal error after an answer delta.
          // Header status cannot change mid-stream. EOF without done/error is always failure.
          return res.end();
        }
        if (error instanceof VoiceTurnError) return res.status(error.status).json({ error: error.message, code: error.code });
        return res.status(500).json({ error: 'Tower voice turn failed', code: 'VOICE_INTERNAL_ERROR' });
      }
    });
  }

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
    if (!current || current.towerSessionId !== req.params.sessionId || current.userId !== userId) return res.status(404).json({ error: 'Voice session not found' });
    // Revoke new admission and mark the owned turn cancelled BEFORE descriptor removal.
    // Engine safe-stop is best effort; 204 does not claim rollback/terminal completion.
    await closeTowerVoiceSession({ voiceSessionId: current.id, sessionId: current.towerSessionId, userId }, Date.parse(current.expiresAt));
    if (!manager.stop(parsed.data.voiceSessionId, userId)) return res.status(404).json({ error: 'Voice session not found' });
    return res.status(204).send();
  });

  return router;
}
