/**
 * Owns: anonymous public-site visitor identity without treating IP addresses as customer identity.
 * Public API: resolvePublicVisitorIdentity. See README.md.
 */
import crypto from 'node:crypto';
import { config } from '../../config.js';

const COOKIE_NAME = '__Host-tower_ai_visitor';
const TOKEN_PREFIX = 'taiv_v1';
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

type CookieRequest = { headers?: { cookie?: unknown } };
type CookieResponse = { appendHeader?: (name: string, value: string) => void; setHeader: (name: string, value: string | string[]) => void; getHeader?: (name: string) => unknown };

export interface PublicVisitorIdentity {
  tenantKey: string;
  userKey: string;
}

function secret(): string {
  if (!config.jwtSecret || config.jwtSecret === 'tower-secret-change-me') {
    throw new Error('AI Service public visitor identity secret is not configured');
  }
  return config.jwtSecret;
}

function signature(visitorId: string): string {
  return crypto.createHmac('sha256', secret()).update(`${TOKEN_PREFIX}.${visitorId}`).digest('base64url');
}

function token(visitorId: string): string {
  return `${TOKEN_PREFIX}.${visitorId}.${signature(visitorId)}`;
}

function verifiedVisitorId(value: string | undefined): string | null {
  if (!value) return null;
  const [prefix, visitorId, actual, extra] = value.split('.');
  if (prefix !== TOKEN_PREFIX || !visitorId || !actual || extra || !/^[A-Za-z0-9_-]{20,80}$/.test(visitorId)) return null;
  const expected = signature(visitorId);
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right) ? visitorId : null;
}

function cookieValue(req: CookieRequest): string | undefined {
  const raw = typeof req.headers?.cookie === 'string' ? req.headers.cookie : '';
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== COOKIE_NAME) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function setVisitorCookie(res: CookieResponse, value: string): void {
  const serialized = `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Max-Age=${MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
  if (typeof res.appendHeader === 'function') {
    res.appendHeader('Set-Cookie', serialized);
    return;
  }
  const current = res.getHeader?.('Set-Cookie');
  const values = Array.isArray(current) ? current.map(String) : current ? [String(current)] : [];
  res.setHeader('Set-Cookie', [...values, serialized]);
}

function scopedKey(label: string, channelId: string, visitorId: string): string {
  const digest = crypto.createHmac('sha256', secret()).update(`${label}\0${channelId}\0${visitorId}`).digest('base64url');
  return digest.slice(0, 43);
}

/** Resolve or mint one signed browser visitor and scope its opaque keys to the public Channel. */
export function resolvePublicVisitorIdentity(req: CookieRequest, res: CookieResponse, channelId: string): PublicVisitorIdentity {
  const normalizedChannelId = String(channelId || '').trim();
  if (!normalizedChannelId) throw new Error('channelId required for public visitor identity');
  let visitorId = verifiedVisitorId(cookieValue(req));
  if (!visitorId) {
    visitorId = crypto.randomBytes(24).toString('base64url');
    setVisitorCookie(res, token(visitorId));
  }
  return {
    tenantKey: `public:${scopedKey('tenant', normalizedChannelId, 'shared')}`,
    userKey: `visitor:${scopedKey('user', normalizedChannelId, visitorId)}`,
  };
}
