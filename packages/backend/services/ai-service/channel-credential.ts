/**
 * Owns signed AI Service Channel credentials for external serving routes.
 * Public API: issueChannelCredential, verifyChannelCredential, credentialFromAuthHeader.
 */
import crypto from 'node:crypto';
import { config } from '../../config.js';

export type AIServiceChannelExposure = 'auth-required' | 'unlisted' | 'public';

export interface ChannelCredentialClaims {
  serviceId: string;
  channelId: string;
  tenantKey: string;
  userKey: string;
  exposure: AIServiceChannelExposure;
  iat: number;
  exp: number;
  nonce: string;
}

export class ChannelCredentialError extends Error {
  status = 401;
  constructor(message: string, status = 401) {
    super(message);
    this.name = 'ChannelCredentialError';
    this.status = status;
  }
}

const TOKEN_PREFIX = 'tasc_v1';
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_TTL_SECONDS = 60 * 60;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function unb64url(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function secret(): string {
  if (!config.jwtSecret || config.jwtSecret === 'tower-secret-change-me') {
    throw new ChannelCredentialError('AI Service Channel credential secret is not configured', 500);
  }
  return config.jwtSecret;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(`${TOKEN_PREFIX}.${payload}`).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function required(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new ChannelCredentialError(`${label} required`, 400);
  if (normalized.length > 200) throw new ChannelCredentialError(`${label} exceeds 200 characters`, 400);
  return normalized;
}

function normalizeTtl(seconds?: number): number {
  const ttl = Number.isFinite(seconds) ? Math.floor(Number(seconds)) : DEFAULT_TTL_SECONDS;
  if (ttl < 60) return 60;
  return Math.min(ttl, MAX_TTL_SECONDS);
}

function normalizeExposure(value: unknown): AIServiceChannelExposure {
  return value === 'public' || value === 'unlisted' || value === 'auth-required' ? value : 'auth-required';
}

/** Issue a short-lived signed credential for one service/channel/tenant/user tuple. */
export function issueChannelCredential(input: {
  serviceId: string;
  channelId: string;
  tenantKey: string;
  userKey: string;
  exposure?: AIServiceChannelExposure;
  ttlSeconds?: number;
  nowSeconds?: number;
}): { token: string; claims: ChannelCredentialClaims; expiresAt: string } {
  const now = Math.floor(input.nowSeconds ?? Date.now() / 1000);
  const claims: ChannelCredentialClaims = {
    serviceId: required(input.serviceId, 'serviceId'),
    channelId: required(input.channelId, 'channelId'),
    tenantKey: required(input.tenantKey, 'tenantKey'),
    userKey: required(input.userKey, 'userKey'),
    exposure: normalizeExposure(input.exposure),
    iat: now,
    exp: now + normalizeTtl(input.ttlSeconds),
    nonce: crypto.randomBytes(12).toString('base64url'),
  };
  const payload = b64url(stable(claims));
  const signature = sign(payload);
  return { token: `${TOKEN_PREFIX}.${payload}.${signature}`, claims, expiresAt: new Date(claims.exp * 1000).toISOString() };
}

/** Verify a Channel credential and optionally bind it to the route service/channel. */
export function verifyChannelCredential(token: string, expected?: { serviceId?: string; channelId?: string; nowSeconds?: number }): ChannelCredentialClaims {
  const raw = String(token || '').trim();
  const [prefix, payload, signature, extra] = raw.split('.');
  if (prefix !== TOKEN_PREFIX || !payload || !signature || extra) throw new ChannelCredentialError('Invalid AI Service Channel credential');
  const expectedSignature = sign(payload);
  if (!safeEqual(signature, expectedSignature)) throw new ChannelCredentialError('Invalid AI Service Channel credential signature');
  let claims: ChannelCredentialClaims;
  try {
    claims = JSON.parse(unb64url(payload));
  } catch {
    throw new ChannelCredentialError('Invalid AI Service Channel credential payload');
  }
  for (const field of ['serviceId', 'channelId', 'tenantKey', 'userKey', 'nonce'] as const) required(claims[field], field);
  claims.exposure = normalizeExposure(claims.exposure);
  const now = Math.floor(expected?.nowSeconds ?? Date.now() / 1000);
  if (!Number.isFinite(claims.exp) || claims.exp <= now) throw new ChannelCredentialError('AI Service Channel credential expired');
  if (!Number.isFinite(claims.iat) || claims.iat > now + 300) throw new ChannelCredentialError('AI Service Channel credential not yet valid');
  if (expected?.serviceId && claims.serviceId !== expected.serviceId) throw new ChannelCredentialError('AI Service Channel credential service mismatch', 403);
  if (expected?.channelId && claims.channelId !== expected.channelId) throw new ChannelCredentialError('AI Service Channel credential channel mismatch', 403);
  return claims;
}

export function channelCredentialTokenHash(token: string): string {
  return crypto.createHash('sha256').update(String(token || '').trim()).digest('hex');
}

export function credentialFromAuthHeader(value: unknown): string {
  const header = typeof value === 'string' ? value.trim() : '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) throw new ChannelCredentialError('Bearer AI Service Channel credential required');
  return match[1].trim();
}
