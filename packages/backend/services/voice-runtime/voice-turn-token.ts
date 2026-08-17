/** Owns: short-lived, voice-only capability tokens for internal Tower turn delegation. */
import crypto from 'node:crypto';
import { config } from '../../config.js';

export interface VoiceTurnClaims { sessionId: string; voiceSessionId: string; userId: number; expiresAt: number; }
const PURPOSE = 'tower-voice-turn-v1';

/** Sign a capability limited to one active voice session, Tower Session, and user. */
export function createVoiceTurnToken(input: { sessionId: string; voiceSessionId: string; userId: number; expiresAt: number }): string {
  const claims: VoiceTurnClaims = {
    sessionId: input.sessionId,
    voiceSessionId: input.voiceSessionId,
    userId: input.userId,
    expiresAt: input.expiresAt,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.createHmac('sha256', config.jwtSecret).update(`${PURPOSE}.${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}

/** Verify a voice-only capability without accepting it as a general Tower login token. */
export function verifyVoiceTurnToken(token: string): VoiceTurnClaims | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', config.jwtSecret).update(`${PURPOSE}.${payload}`).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as VoiceTurnClaims;
    if (!claims.sessionId || !claims.voiceSessionId || !Number.isInteger(claims.userId) || claims.expiresAt <= Date.now()) return null;
    return claims;
  } catch { return null; }
}
