/**
 * credential-health.ts — Owns: Claude account OAuth credential lifecycle parsing.
 * Public API: readCredentialHealth(configDir). See README.md.
 *
 * Read-only observer of <configDir>/.credentials.json. Returns a CredentialHealth
 * record with a 4-level status (healthy / warning / critical / missing|malformed)
 * derived from expiresAt + refreshToken presence. The admin UI maps these to
 * 🟢🟡🔴 dots; never mutates the credentials file or attempts auto-refresh
 * (SDK owns refresh; we observe only).
 *
 * Phase 1 of the multi-account/multi-provider umbrella decision:
 *   workspace/decisions/2026-05-25-multi-account-multi-provider-umbrella.md
 *
 * lastUsedAt is reserved for PR-3 (claude-engine call trace). PR-1 always
 * returns null for that field.
 */

import fs from 'fs/promises';
import path from 'path';

export type CredentialStatus =
  | 'healthy'
  | 'warning'
  | 'critical'
  | 'missing'
  | 'malformed';

export interface CredentialHealth {
  configDir: string;
  status: CredentialStatus;
  /** One-line human-readable explanation of the status. */
  reason: string;
  /** Token expiry (null if file missing/malformed or expiresAt absent). */
  expiresAt: Date | null;
  /** Days from `now` until expiresAt. Negative means already expired. */
  daysUntilExpiry: number | null;
  /** True iff refreshToken is a non-empty string. Pre-2026 v1 tokens have ''. */
  hasRefreshToken: boolean;
  /** Tower 2026-05-04 §"subscriptionType is misleading" — informational only. */
  subscriptionType: string | null;
  /** Tower 2026-05-04 §D — ground truth for tier identification. */
  rateLimitTier: string | null;
  /** Last successful API call timestamp. PR-3 will populate; PR-1 returns null. */
  lastUsedAt: Date | null;
}

const WARN_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Read and classify the health of a Claude account's OAuth credential file.
 *
 * Never throws — every failure mode (file absent, JSON broken, fields missing,
 * expired) is mapped to a CredentialStatus + reason string. Caller code can
 * treat the return value as a total function.
 *
 * @param configDir Absolute path to a Claude account dir (e.g. ~/.claude-gmail).
 * @param opts.now  Injectable clock for deterministic tests.
 */
export async function readCredentialHealth(
  configDir: string,
  opts: { now?: Date } = {}
): Promise<CredentialHealth> {
  const now = opts.now ?? new Date();
  const credPath = path.join(configDir, '.credentials.json');

  const base: Omit<CredentialHealth, 'status' | 'reason'> = {
    configDir,
    expiresAt: null,
    daysUntilExpiry: null,
    hasRefreshToken: false,
    subscriptionType: null,
    rateLimitTier: null,
    lastUsedAt: null,
  };

  let raw: string;
  try {
    raw = await fs.readFile(credPath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return { ...base, status: 'missing', reason: `credentials.json not found at ${credPath}` };
    }
    return {
      ...base,
      status: 'malformed',
      reason: `failed to read credentials.json: ${err?.message ?? String(err)}`,
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    return {
      ...base,
      status: 'malformed',
      reason: `invalid JSON in credentials.json: ${err?.message ?? String(err)}`,
    };
  }

  const oauth = parsed?.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object') {
    return { ...base, status: 'malformed', reason: 'missing claudeAiOauth field' };
  }

  const expiresAt =
    typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt)
      ? new Date(oauth.expiresAt)
      : null;
  const hasRefreshToken =
    typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0;
  const subscriptionType =
    typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null;
  const rateLimitTier =
    typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : null;

  const enriched = {
    ...base,
    expiresAt,
    hasRefreshToken,
    subscriptionType,
    rateLimitTier,
  };

  if (!expiresAt) {
    return { ...enriched, status: 'malformed', reason: 'missing or invalid expiresAt field' };
  }

  const msUntilExpiry = expiresAt.getTime() - now.getTime();
  const daysUntilExpiry = msUntilExpiry / MS_PER_DAY;
  enriched.daysUntilExpiry = daysUntilExpiry;

  // 🔴 critical — already expired
  if (msUntilExpiry <= 0) {
    const absMs = -msUntilExpiry;
    const reason =
      absMs < MS_PER_DAY
        ? `token expired ${Math.round(absMs / MS_PER_HOUR)}h ago`
        : `token expired ${Math.round(absMs / MS_PER_DAY)} days ago`;
    return { ...enriched, status: 'critical', reason };
  }

  // 🟡 warning — no refresh token (any expiry distance is risky)
  if (!hasRefreshToken) {
    return {
      ...enriched,
      status: 'warning',
      reason: `no refresh token (pre-2026 v1 OAuth flow) — re-login required after expiry in ${Math.round(daysUntilExpiry)}d`,
    };
  }

  // 🟡 warning — expiring within 7 days
  if (daysUntilExpiry < WARN_DAYS) {
    const dispDays = Math.round(daysUntilExpiry * 10) / 10;
    return {
      ...enriched,
      status: 'warning',
      reason: `expiring in ${dispDays}d (< ${WARN_DAYS}d threshold)`,
    };
  }

  // 🟢 healthy
  const tierSuffix = rateLimitTier ? `, tier=${rateLimitTier}` : '';
  return {
    ...enriched,
    status: 'healthy',
    reason: `active, ${Math.round(daysUntilExpiry)}d until expiry${tierSuffix}`,
  };
}
