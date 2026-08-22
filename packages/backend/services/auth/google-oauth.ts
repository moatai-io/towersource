/**
 * google-oauth.ts — Google OAuth 2.0 flow for Gmail, Calendar, Drive.
 *
 * Handles:
 * 1. Generating OAuth URL (redirect user to Google)
 * 2. Exchanging authorization code for tokens
 * 3. Registering token refresher with oauth-manager
 *
 * Requires .env:
 *   GOOGLE_CLIENT_ID=...
 *   GOOGLE_CLIENT_SECRET=...
 *   GOOGLE_REDIRECT_URI=https://tower.tower.example.com/api/auth/google/callback
 */

import { config } from '../../config.js';
// RefreshFn 은 로컬 oauth-manager 의 정의를 쓴다 (notify-hub 와 구조 동일).
// notify-hub 폐기(#58 Phase 1) 의 일부 — google OAuth 를 외부 메시징 의존에서 분리.
import type { RefreshFn } from './oauth-manager.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

// Scopes for Gmail + Calendar + Drive. Gmail compose/send are included so
// user-owned GWS connections can support draft/send workflows with explicit
// user confirmation at send time.
export const GOOGLE_DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

export interface GoogleOAuthReadiness {
  configured: boolean;
  ready: boolean;
  publicUrl: string;
  redirectUri: string;
  expectedRedirectUri: string;
  secureRedirect: boolean;
  redirectMatchesPublicUrl: boolean;
  reason: 'ready' | 'client_not_configured' | 'https_required' | 'redirect_uri_mismatch';
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function getGoogleOAuthReadiness(): GoogleOAuthReadiness {
  const publicUrl = config.publicUrl.replace(/\/$/, '');
  const redirectUri = config.googleRedirectUri;
  const expectedRedirectUri = publicUrl ? `${publicUrl}/api/auth/google/callback` : redirectUri;
  let secureRedirect = false;
  try {
    const parsed = new URL(redirectUri);
    secureRedirect = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname));
  } catch {}
  const configured = Boolean(config.googleClientId && config.googleClientSecret && redirectUri);
  const redirectMatchesPublicUrl = Boolean(redirectUri && expectedRedirectUri && redirectUri === expectedRedirectUri);
  const ready = configured && secureRedirect && redirectMatchesPublicUrl;
  const reason = !configured
    ? 'client_not_configured'
    : !secureRedirect
      ? 'https_required'
      : !redirectMatchesPublicUrl
        ? 'redirect_uri_mismatch'
        : 'ready';
  return { configured, ready, publicUrl, redirectUri, expectedRedirectUri, secureRedirect, redirectMatchesPublicUrl, reason };
}

export function isGoogleOAuthConfigured(): boolean {
  return getGoogleOAuthReadiness().ready;
}

/**
 * Generate Google OAuth consent URL.
 * @param state - Opaque state to pass through (e.g., userId or session token)
 */
export function getGoogleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.googleRedirectUri,
    response_type: 'code',
    scope: GOOGLE_DEFAULT_SCOPES.join(' '),
    access_type: 'offline',      // Get refresh_token
    prompt: 'consent',           // Force consent to always get refresh_token
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access + refresh tokens.
 */
export async function exchangeGoogleCode(code: string): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  idToken?: string;
}> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: config.googleRedirectUri,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google token exchange failed: ${err}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in ?? 3600,
    idToken: data.id_token,
  };
}

/**
 * Get user info (email, name) from Google.
 */
export async function getGoogleUserInfo(accessToken: string): Promise<{
  email: string;
  name: string;
}> {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error('Failed to get Google user info');
  }

  const data = await res.json();
  return {
    email: data.email ?? '',
    name: data.name ?? data.email ?? '',
  };
}

/**
 * Create a Google token refresher for oauth-manager.
 */
export function createGoogleRefresher(): RefreshFn {
  return async (refreshToken: string) => {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Google refresh failed: ${err}`);
    }

    const data = await res.json();
    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in ?? 3600,
      // Google doesn't return a new refresh_token on refresh
    };
  };
}
