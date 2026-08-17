import { useEffect, useState } from 'react';
import { CHANGELOG } from '../data/changelog';
import { hasSeenTowerGuide } from '../tours/tourState';

const CURRENT_VERSION = CHANGELOG[0].version;

function lastVersionKey(userId: string) {
  return `tower:lastSeenVersion:${userId}`;
}

interface UseOnboardingOptions {
  token: string | null;
  userId: string | null;
  sessionsLoaded: boolean;
}

interface OnboardingState {
  showWhatsNew: boolean;
  dismissWhatsNew: () => void;
}

export function useOnboarding({
  token,
  userId,
  sessionsLoaded,
}: UseOnboardingOptions): OnboardingState {
  const [showWhatsNew, setShowWhatsNew] = useState(false);

  // What's New: 버전 변경 감지. 신규/기존 판단은 세션 개수가 아니라
  // 사용자별 guide seen 상태를 기준으로 삼는다.
  useEffect(() => {
    if (!userId || !token || !sessionsLoaded) return;

    const lastVersion = localStorage.getItem(lastVersionKey(userId));

    if (!hasSeenTowerGuide(userId)) return;
    if (!lastVersion) {
      localStorage.setItem(lastVersionKey(userId), CURRENT_VERSION);
      return;
    }
    if (lastVersion !== CURRENT_VERSION) {
      setShowWhatsNew(true);
    }
  }, [userId, token, sessionsLoaded]);

  const dismissWhatsNew = () => {
    setShowWhatsNew(false);
    if (userId) {
      localStorage.setItem(lastVersionKey(userId), CURRENT_VERSION);
    }
  };

  return { showWhatsNew, dismissWhatsNew };
}
