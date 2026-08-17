/**
 * Auth helpers — single source of truth for the current user's identity.
 *
 * Owns: client-side reads of the JWT payload (role, userId, username).
 * Public API: getCurrentRole / getCurrentUserId / getCurrentUsername / isOperatorOrAdmin.
 *
 * Why: backend verifies the JWT and stamps `role` into the payload. Anything
 * mirrored into localStorage (e.g. a `userRole` key written at login response
 * time) can go stale or be missing (cookie/SSO entry, manual clear, hot-swap
 * across sessions), causing UI to think the user has fewer permissions than
 * they actually do. The token itself is the only value we *receive from backend*
 * and therefore the only one safe to gate UI on.
 *
 * NOTE: this is *client-side hint* only. Backend still authorizes every request
 * via verifyToken middleware — the UI gates are purely cosmetic.
 *
 * See: workspace/decisions/2026-05-22-frontend-role-from-jwt.md (TBD)
 */

interface JwtPayload {
  userId?: number;
  username?: string;
  role?: string;
  aud?: string;
}

function decodeToken(token: string | null): JwtPayload | null {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    return JSON.parse(atob(parts[1]));
  } catch {
    return null;
  }
}

function readToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('token');
}

/** Current user's role per JWT, or null if no/invalid token. */
export function getCurrentRole(): string | null {
  return decodeToken(readToken())?.role ?? null;
}

/** Current user's userId per JWT, or 0 if unavailable. */
export function getCurrentUserId(): number {
  return decodeToken(readToken())?.userId ?? 0;
}

/** Current user's username per JWT, or empty string. */
export function getCurrentUsername(): string {
  return decodeToken(readToken())?.username ?? '';
}

/** True if the current user is admin or operator. */
export function isOperatorOrAdmin(): boolean {
  const r = getCurrentRole();
  return r === 'admin' || r === 'operator';
}
