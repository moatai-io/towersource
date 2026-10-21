import { Router } from 'express';
import { authMiddleware } from '../services/auth/auth.js';
import { canAccessSession } from '../services/pm/project-access.js';
import { getSession } from '../services/session/session-manager.js';
import { GatewayProfileClientError, resolveGatewayApiClient } from '../services/gateway-profile/gateway-profile-client.js';

const router = Router();
// Read-only readiness: no microphone access, provider generation, or paid request.
router.get('/sessions/:sessionId/voice-readiness', authMiddleware, async (req, res) => {
  const actor = (req as any).user;
  try {
    const access = await canAccessSession(String(req.params.sessionId), Number(actor.userId), actor.role);
    if (!access.allowed) { res.status(access.status).json({ error: access.message }); return; }
    const session = await getSession(String(req.params.sessionId));
    if (!session?.projectId) { res.status(404).json({ error: '세션을 찾을 수 없습니다.' }); return; }
    const connections = await Promise.all(['speech-to-text', 'text-to-speech'].map(async apiId => {
      try {
        await resolveGatewayApiClient({ actorUserId: Number(actor.userId), projectId: session.projectId!, apiId });
        return { apiId, configured: true };
      } catch { return { apiId, configured: false }; }
    }));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ configured: connections.every(c => c.configured), connections, providerVerified: false });
  } catch { res.status(503).json({ error: '음성 연결 설정을 확인할 수 없습니다.' }); }
});
/** Gateway-only TTS. Provider secrets and upstream errors never reach the browser. */
router.post('/sessions/:sessionId/answer-speech', authMiddleware, async (req, res) => {
  const actor = (req as any).user;
  try {
    const access = await canAccessSession(String(req.params.sessionId), Number(actor.userId), actor.role);
    if (!access.allowed) { res.status(access.status).json({ error: access.message }); return; }
    const session = await getSession(String(req.params.sessionId));
    if (!session?.projectId) { res.status(404).json({ error: '세션을 찾을 수 없습니다.' }); return; }
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 5000) {
      res.status(400).json({ error: '낭독할 텍스트는 1~5,000자여야 합니다.' }); return;
    }
    const gateway = await resolveGatewayApiClient({ actorUserId: Number(actor.userId), projectId: session.projectId, apiId: 'text-to-speech' });
    const cancelled = new AbortController();
    const onClose = () => { if (!res.writableEnded) cancelled.abort(); };
    res.once('close', onClose);
    const response = await fetch(gateway.baseUrl, {
      method: 'POST', headers: { Authorization: `Bearer ${gateway.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_v4' }),
      signal: AbortSignal.any([cancelled.signal, AbortSignal.timeout(60_000)]),
    });
    if (!response.ok) throw new Error('Speech upstream unavailable');
    const data = await response.json() as any;
    const alignment = data.alignment;
    if (typeof data.audio_base64 !== 'string' || !Array.isArray(alignment?.characters)
      || !Array.isArray(alignment?.character_start_times_seconds) || !Array.isArray(alignment?.character_end_times_seconds)) {
      throw new Error('Invalid speech response');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ audio_base64: data.audio_base64, alignment });
  } catch (error) {
    const missingCatalog = error instanceof GatewayProfileClientError && error.code === 'GATEWAY_API_NOT_ALLOWED';
    res.status(503).json({ error: missingCatalog ? '이 서버에 음성 읽기 연결이 아직 등록되지 않았습니다. 운영 설정을 확인해 주세요.' : '음성 읽기 연결을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.' });
  }
});
export default router;
