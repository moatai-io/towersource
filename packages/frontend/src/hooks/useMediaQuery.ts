import { useState, useEffect } from 'react';

interface Options {
  /**
   * Debounce 'change' events by this many ms. Useful for media queries
   * driving big layout swaps (e.g. mobile ↔ desktop chrome) — without it,
   * micro viewport jitter (browser zoom, scrollbar appearance,
   * fingerprinting protection randomization, brief frame resizes during
   * Virtuoso reflows) can flip the result and cause visible footer/header
   * height bouncing.
   *
   * Initial mount is NOT debounced — the first reading reflects the real
   * viewport size synchronously. Only subsequent transitions are gated.
   */
  debounceMs?: number;
}

export function useMediaQuery(query: string, options?: Options): boolean {
  const [matches, setMatches] = useState(() => {
    // SSR / test 환경 (jsdom 기본은 matchMedia 미구현) 에서는 false 로 fallback.
    // jsdom 에서 호출 사이트가 늘어날 때마다 setup 에 polyfill 박는 부담을 피함.
    if (typeof window === 'undefined') return false;
    if (typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const debounceMs = options?.debounceMs ?? 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const handler = (e: MediaQueryListEvent) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (debounceMs > 0) {
        timer = setTimeout(() => {
          // Re-check the live query in case it flapped back during the wait.
          // Without this, a fast flap (false → true → false within debounceMs)
          // would still apply the stale `e.matches` value.
          setMatches(window.matchMedia(query).matches);
          timer = null;
        }, debounceMs);
      } else {
        setMatches(e.matches);
      }
    };

    mq.addEventListener('change', handler);
    // Sync once on mount (in case it changed between useState init and effect run).
    setMatches(mq.matches);

    return () => {
      mq.removeEventListener('change', handler);
      if (timer) clearTimeout(timer);
    };
  }, [query, options?.debounceMs]);

  return matches;
}
