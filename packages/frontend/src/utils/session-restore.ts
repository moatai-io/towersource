/**
 * Decode a JWT payload (no signature verification — client-side only, used as localStorage key).
 * Returns userId from the payload, or 0 if unavailable.
 */
export function getTokenUserId(token: string | null): number {
  if (!token) return 0;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return 0;
    const payload = JSON.parse(atob(parts[1]));
    return payload.userId ?? 0;
  } catch {
    return 0;
  }
}

/** localStorage key for the last-viewed session, scoped by userId */
export function lastViewedKey(userId: number): string {
  return `tower_lastViewed_${userId}`;
}
