export const TOUR_STATE_CHANGED_EVENT = 'tower-tour-state-changed';

function userScopedKey(userId: string, name: string) {
  return `tower:${name}:${userId}`;
}

function currentUserId(): string | null {
  try {
    return localStorage.getItem('userId');
  } catch {
    return null;
  }
}

export function guideSeenKey(userId: string) {
  return userScopedKey(userId, 'guideSeen');
}

export function tourCompletedKey(userId: string, tourId: string) {
  return userScopedKey(userId, `tourCompleted:${tourId}`);
}

export function hasSeenTowerGuide(userId = currentUserId()): boolean {
  if (!userId) return false;
  try {
    return localStorage.getItem(guideSeenKey(userId)) === 'true';
  } catch {
    return false;
  }
}

export function markTowerGuideSeen(userId = currentUserId()) {
  if (!userId) return;
  try {
    localStorage.setItem(guideSeenKey(userId), 'true');
    localStorage.setItem(userScopedKey(userId, 'guideSeenAt'), new Date().toISOString());
  } catch {}
  window.dispatchEvent(new CustomEvent(TOUR_STATE_CHANGED_EVENT));
}

export function markTourCompleted(tourId: string, userId = currentUserId()) {
  if (!userId) return;
  try {
    localStorage.setItem(tourCompletedKey(userId, tourId), 'true');
    localStorage.setItem(userScopedKey(userId, `tourCompletedAt:${tourId}`), new Date().toISOString());
  } catch {}
  markTowerGuideSeen(userId);
}
